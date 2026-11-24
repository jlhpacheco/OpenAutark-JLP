// Owns: pairing this phone with a PC by its Remote ID (B-078, the steps in PhonePairing), and afterwards keeping an
// encrypted channel to EVERY PC of the company that is online (B-084 M1, at most PcLinks.CAP), each a tunnel through the
// one meeting-server connection – the phone belongs to the company, not to one PC: it pins every PC it knows (the list
// grows with phoneUse.attach, phoneuse/UseLink), learns each PC's version (PcVersion), reconnects with backoff
// (0.5 s … 10 s, per PC) after the server or a PC went away, and hands the local entrance (StreamProxy) the channel the
// page uses (PcLinks: the picked PC, else the newest version; a slow PC never holds a waiting request past its wait);
// when that PC drops, the page moves to another channel at once and its old streams end. check() (resume, network change) resets the backoff and probes the link at once;
// onLinked hears every move of the page to a new channel; prefer() is the picker's choice; refused() (the PC refused the
// page's token) moves the page to a PC of the company that has not refused while this connection lives.
// F29 stage 1 (16.11.2026): a channel goes straight to the PC whenever one of its addresses (phoneUse.attach, kept with
// the PC) answers – Route races them and falls back to the tunnel, the same handshake either way; the direct socket
// replaces that PC's tunnel. After a resume or a network change the page's PC, if reached through the tunnel, is tried
// directly once and a direct channel takes its place (home Wi-Fi while mobile data stays up).
// F25 stage 2 (16.11.2026): when the page's PC is reached through the tunnel, the phone also tries the WebRTC way to it
// (RtcWay over that channel, A; RtcPlan says when – once per channel and after each check(), no timer loop). Once the
// PC says ready on the data channel, that channel (B) is the page's: new streams go there, the ones on A end and the
// page hears 'resume'. A stays open and idle; when B ends, the page is back on A at once. Without an Engine (no
// WebRTC on this phone) nothing of this runs.
// W (19.11.2026): wake() sends a closed PC's wake over the same meeting-server link (Wake) – it needs no PC online.
// Never: stores anything itself (the caller keeps Paired), polls the PC, or talks to a PC it does not pin.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

public final class PhoneConnection implements StreamProxy.Channels {
    /** One PC of the company as the phone keeps it. */
    public static final class Pc {
        public final String fingerprint;
        public final String publicKey;
        public final String name;
        public final String deviceId;
        /** F29: the PC's peer listener addresses (http(s) base URLs, at most 8) the phone dials directly. */
        public final List<String> addresses;
        public Pc(String fingerprint, String publicKey, String name, String deviceId) { this(fingerprint, publicKey, name, deviceId, null); }
        public Pc(String fingerprint, String publicKey, String name, String deviceId, List<String> addresses) {
            this.fingerprint = fingerprint; this.publicKey = publicKey; this.name = name == null ? "PC" : name; this.deviceId = deviceId == null ? "" : deviceId;
            this.addresses = addresses == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(addresses));
        }
    }

    /** What pairing gives the phone (kept in app-private storage by the caller). */
    public static final class Paired {
        public final String relay;
        public final String seed;
        public final String deviceId;
        public final String token;
        public final List<Pc> pcs;

        public Paired(String relay, String seed, String deviceId, String token, List<Pc> pcs) {
            this.relay = relay; this.seed = seed; this.deviceId = deviceId; this.token = token;
            this.pcs = Collections.unmodifiableList(new ArrayList<>(pcs));
        }

        /** The PCs as JSON (app storage). */
        public String pcsJson() {
            List<Object> out = new ArrayList<>();
            for (Pc pc : pcs) {
                Map<String, Object> row = Json.map("fingerprint", pc.fingerprint, "publicKey", pc.publicKey, "name", pc.name, "deviceId", pc.deviceId);
                if (!pc.addresses.isEmpty()) row.put("addresses", new ArrayList<Object>(pc.addresses));
                out.add(row);
            }
            return Json.write(out);
        }

        /** PCs from storage JSON or from phoneUse.attach's `pcs` (keys fingerprint, publicKey, name, deviceId); bad rows are skipped. */
        public static List<Pc> pcsOf(Object value) { return PhonePairing.pcsOf(value); }

        public Paired withPcs(List<Pc> next) { return new Paired(relay, seed, deviceId, token, next); }
    }

    public interface Status { void changed(String text, boolean connected); }

    /** Shows the code while the person compares it on the PC. */
    public interface Codes { void code(String code, String pcName); }

    /** A pairing in progress; cancel() ends it (the PC hears it). */
    public static final class Pairing {
        volatile boolean cancelled;
        volatile RelayLink link;
        public void cancel() { cancelled = true; RelayLink current = link; if (current != null) current.close(); }
        public boolean cancelled() { return cancelled; }
    }

    private static final long[] BACKOFF_MS = { 500, 1_000, 2_000, 5_000, 10_000 };

    /** The pause after `attempt` failed tries in a row. */
    static long backoff(int attempt) { return BACKOFF_MS[Math.max(0, Math.min(attempt, BACKOFF_MS.length - 1))]; }

    /** Pairs a new phone key with the PC under `remoteId`: the code shows through `codes`, then the person accepts on the PC. */
    public static Paired pair(String relay, String remoteId, String name, Pairing pairing, Codes codes) throws IOException {
        return PhonePairing.pair(relay, remoteId, name, pairing, codes);
    }

    private volatile Paired paired;
    private final byte[] seed;
    private final Status status;
    private final Object lock = new Object();
    private StreamProxy proxy;
    private Thread worker;
    private volatile RelayLink link;
    private final PcLinks<PeerChannel> links = new PcLinks<>(PeerChannel::isClosed);
    /** The page's channel the loop announced last (loop thread). */
    private PeerChannel shown;
    private volatile boolean stopped;
    private boolean wake;
    private volatile int attempt;
    private volatile boolean probeNow;
    /** F29: after check(), the page's PC reached through the tunnel is tried directly once. */
    private volatile boolean directNow;
    private volatile String preferred;
    private volatile Runnable linked;
    private static final long VERSION_MS = 4_000;
    /** F25: the WebRTC way to the page's PC, or null when this phone has no libwebrtc. */
    private final PageRtc rtc;

    public PhoneConnection(Paired paired, Status status) { this(paired, status, null); }

    public PhoneConnection(Paired paired, Status status, RtcEngine engine) {
        this.paired = paired;
        this.seed = Crypto.fromB64url(paired.seed);
        this.status = status;
        this.rtc = engine == null ? null : new PageRtc(engine, seed, paired.deviceId, new PageRtc.Host() {
            @Override public void deliver(PeerChannel b, Map<String, Object> message) { proxy.deliver(b, message); }
            @Override public void channelClosed(PeerChannel b) { proxy.channelClosed(b); }
            @Override public void nudge() { PhoneConnection.this.nudge(); }
        });
    }

    /** Opens the local entrance (127.0.0.1:`port`, else any free port) and starts connecting; returns its origin. */
    public String start(int port, String gate) throws IOException {
        proxy = new StreamProxy(port, gate, this);
        worker = new Thread(this::run, "autark-connection");
        worker.setDaemon(true);
        worker.start();
        return proxy.origin();
    }

    public void stop() {
        stopped = true;
        nudge();
        RelayLink current = link;
        if (current != null) current.close(); // first: it ends the tunnels too and never waits for a stuck send (UI thread)
        for (PeerChannel open : links.all()) open.close();
        if (rtc != null) rtc.stop();
        closeEntrance();
    }

    /** Frees the local entrance's port now (a loopback listener: no network write, fine on Android's main thread). */
    public void closeEntrance() { if (proxy != null) proxy.close(); }

    /** The page's PC refused the page's token (4401, the page's 'refused'): the page moves to the next PC of the company
     *  that has not refused in this connection; when every linked PC refused, the page stays where it is ('Not paired'). */
    public void refused() {
        if (links.refuse(links.usedPc())) nudge();
    }

    /** Try now instead of after the pause. */
    public void nudge() {
        synchronized (lock) { wake = true; lock.notifyAll(); }
    }

    /** The app came to the front or the network changed: the backoff starts over, the link proves itself within 2 s, and a
     *  page on the tunnel tries its PC directly once (F29). */
    public void check() {
        attempt = 0;
        links.retryNow();
        directNow = true;
        if (rtc != null) rtc.check(); // F25: the WebRTC way gets one more try (now, or when the one standing ends)
        probe();
    }

    /** The link and every direct channel are probed on the connection's own thread (a stuck send never blocks the caller). */
    @Override public void probe() {
        probeNow = true;
        nudge();
    }

    /** Runs on the connection's thread whenever the page moves to a new channel – another PC, or its PC again after a drop (the page then hears `resume`). */
    public void onLinked(Runnable listener) { linked = listener; }

    /** The company's PCs changed (phoneUse.attach): a new or removed pin re-registers at the server (its tunnels end and come back); a new order only is kept. */
    public void updatePcs(List<Pc> pcs) {
        if (pcs.isEmpty()) return;
        List<Pc> next = PhonePairing.preferring(pcs, preferred);
        Paired before = paired;
        if (before.pcsJson().equals(before.withPcs(next).pcsJson())) return;
        paired = before.withPcs(next);
        RelayLink current = link;
        if (current != null && !PhonePairing.samePins(before.pcs, next)) current.close();
        nudge();
    }

    /** The picker's choice: that PC goes first (the caller stores paired()) and the page uses it whenever its channel is up. */
    public void prefer(String fingerprintHex) {
        boolean again = links.forgive(fingerprintHex); // the person's pick tries a PC that refused once more
        Paired before = paired;
        List<Pc> next = PhonePairing.preferring(before.pcs, fingerprintHex);
        if (next == before.pcs) { if (again) nudge(); return; }
        preferred = fingerprintHex;
        paired = before.withPcs(next);
        nudge();
    }

    public Paired paired() { return paired; }

    /** The pinned PCs in the phone's order, for the picker. */
    public List<Pc> pcs() { return paired.pcs; }

    /** W (19.11.2026): wakes a PC of mine whose app is closed (its helper key `wakePub`) through this connection's
     *  meeting-server link (Wake) – no PC needs to be online. Any thread but the main one (network). */
    public void wake(String wakePub, String name) throws IOException {
        RelayLink current = link;
        if (current == null || !current.isUp()) { nudge(); throw new IOException("This phone can't reach the meeting server right now – try again in a moment."); }
        Wake.send(current, seed, wakePub, name, System.currentTimeMillis());
    }

    /** True when the meeting server reports the PC `fingerprintHex` online now. */
    public boolean online(String fingerprintHex) {
        RelayLink current = link;
        return current != null && current.isUp() && current.online(fingerprintHex);
    }

    /** The name of the PC the page uses now, or null while there is none. */
    public String pcName() {
        String fp = links.usedPc();
        return fp == null ? null : nameOf(fp);
    }

    /** Open channels to PCs of the company (the page's one included). */
    public int linkedCount() { return links.live(); }

    /** The Autark version of the page's PC, or null (none, or it did not say). */
    public String version() { return links.usedVersion(); }

    @Override public PeerChannel await(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            PeerChannel used;
            while (!stopped && (used = links.used()) == null) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) return viaWay(links.pick(order(), preferred)); // a round still opening a slow PC: a linked one serves now (null: none)
                wake = true;
                lock.notifyAll();
                try { lock.wait(Math.min(left, 1_000)); } catch (InterruptedException error) { Thread.currentThread().interrupt(); return null; }
            }
            return viaWay(links.used());
        }
    }

    @Override public PeerChannel used() { return viaWay(links.used()); }

    /** F25: the channel the page's streams take for PC channel `a` – its WebRTC channel B while that carries, else `a`. */
    private PeerChannel viaWay(PeerChannel a) { return rtc == null ? a : rtc.via(a); }

    private void run() {
        while (!stopped) {
            try {
                ensureLink();
                RelayLink current = link;
                if (probeNow) { probeNow = false; current.probe(); for (PeerChannel open : links.all()) open.probe(); }
                List<String> order = order();
                for (PeerChannel gone : links.prune(order)) gone.close();
                if (links.used() == null && links.live() > 0) settle(order, current, null); // the page's PC dropped: move now, not after this round's opens
                String failure = null;
                for (String fp : links.toOpen(order, current::online, System.currentTimeMillis())) {
                    if (stopped) break;
                    if (links.used() == null) say("Connecting to " + nameOf(fp) + "…", false);
                    try { openChannel(fp, false); }
                    catch (IOException | RuntimeException error) { links.failed(fp, System.currentTimeMillis()); failure = error.getMessage(); }
                }
                settle(order, current, failure);
                if (directNow) { directNow = false; if (tryDirect()) settle(order, current, null); }
                long now = System.currentTimeMillis();
                if (rtc != null && !stopped) { String fp = links.usedPc(); rtc.step(links.used(), fp == null ? null : keyOf(fp)); }
                pause(Math.min(15_000, Math.min(links.nextRetry(now), rtc == null ? Long.MAX_VALUE : rtc.nextAgain(now))));
                current.checkAlive();
                for (PeerChannel open : links.all()) open.checkAlive();
            } catch (IOException | RuntimeException error) {
                say(error.getMessage() == null ? "Connection failed." : error.getMessage(), false);
                pause(backoff(attempt++));
            }
        }
        RelayLink current = link; // stop() may have come while a link or channel was being made: what I made last ends here
        for (PeerChannel open : links.all()) open.close();
        if (current != null) current.close();
    }

    /** The page's PC after this round: a move ends the streams left on other channels and tells the listener. */
    private void settle(List<String> order, RelayLink current, String failure) {
        PeerChannel next;
        synchronized (lock) { next = viaWay(links.pick(order, preferred)); lock.notifyAll(); }
        boolean moved = next != null && next != shown;
        shown = next;
        if (next != null) {
            attempt = 0;
            int others = links.live() - 1;
            say("Connected to " + nameOf(links.usedPc()) + (next.direct() ? " directly" : "") + (others > 0 ? " (+" + others + ")" : "") + ".", true);
            if (moved) {
                proxy.retire(next);
                Runnable listener = linked;
                if (listener != null && !stopped) listener.run();
            }
            return;
        }
        boolean any = false;
        for (String fp : order) any |= current.online(fp);
        if (!any) say("None of your PCs is online. Autark has to be running on at least one of them.", false);
        else if (failure != null) say(failure, false); // else: an online PC waits its retry, the last line stays
    }

    /** The pinned PCs' fingerprints in the phone's order. */
    private List<String> order() {
        List<String> out = new ArrayList<>();
        for (Pc pc : paired.pcs) out.add(pc.fingerprint);
        return out;
    }

    private String nameOf(String fp) {
        for (Pc pc : paired.pcs) if (pc.fingerprint.equals(fp)) return pc.name;
        return "your PC";
    }

    private byte[] keyOf(String fp) {
        for (Pc pc : paired.pcs) if (pc.fingerprint.equals(fp)) return Crypto.fromB64url(pc.publicKey);
        return null;
    }

    private List<String> addressesOf(String fp) {
        for (Pc pc : paired.pcs) if (pc.fingerprint.equals(fp)) return pc.addresses;
        return Collections.emptyList();
    }

    /** F29: the page's PC, reached through the tunnel, tried directly once; true when a direct channel took its place. */
    private boolean tryDirect() {
        String fp = links.usedPc();
        PeerChannel used = links.used();
        if (fp == null || used == null || used.direct() || addressesOf(fp).isEmpty()) return false;
        try { openChannel(fp, true); } catch (IOException | RuntimeException error) { return false; } // it stays on the tunnel
        used.close(); // its streams end, the page hears 'resume' on the direct channel
        return true;
    }

    private void ensureLink() throws IOException {
        if (link != null && link.isUp()) return;
        Map<String, byte[]> pins = new LinkedHashMap<>();
        for (Pc pc : paired.pcs) pins.put(pc.fingerprint, Crypto.fromB64url(pc.publicKey));
        RelayLink next = new RelayLink(seed, pins, new RelayLink.Events() {
            @Override public void presence(boolean online) { nudge(); }
            @Override public void down(String reason) { nudge(); }
        });
        say("Reaching the meeting server…", false);
        next.connect(paired.relay);
        synchronized (lock) { link = next; }
    }

    /** A channel to `fp`: straight to one of its addresses when one answers, else (unless `directOnly`) through the tunnel. */
    private void openChannel(String fp, boolean directOnly) throws IOException {
        byte[] pcPub = keyOf(fp);
        if (pcPub == null) throw new IOException("That PC is not one of yours.");
        RelayLink relay = link;
        Route.Opener tunnel = directOnly ? null : () -> relay.open(fp);
        PeerChannel[] holder = new PeerChannel[1];
        AtomicReference<PcVersion> asking = new AtomicReference<>(); // read on the pipe's reader thread
        PeerChannel.Listener listener = new PeerChannel.Listener() {
            @Override public void message(Map<String, Object> message) {
                PcVersion question = asking.get();
                if (PcVersion.mine(message)) { if (question != null) question.deliver(message); return; }
                PeerChannel current = holder[0];
                if (RtcSignal.mine(message)) { if (rtc != null) rtc.signal(current, message); return; } // F25: the PC's side of a try
                if (current != null) proxy.deliver(current, message);
            }
            @Override public void closed() {
                PcVersion question = asking.get();
                if (question != null) question.deliver(Json.map("t", "e")); // the version wait ends with the channel
                PeerChannel current = holder[0];
                if (current != null) proxy.channelClosed(current);
                if (rtc != null) rtc.closed(current); // F25: a way on this channel ends with it
                nudge();
            }
        };
        PeerChannel next = Route.open(DirectPipe.openers(addressesOf(fp)), Route.DIRECT_MS, tunnel,
                (pipe) -> PeerChannel.connect(pipe, seed, paired.deviceId, pcPub, listener));
        holder[0] = next;
        PcVersion question = new PcVersion(next::send);
        asking.set(question);
        String version = question.fetch(paired.token, VERSION_MS); // one small request: which Autark this PC runs
        asking.set(null);
        if (next.isClosed()) throw new IOException(nameOf(fp) + " closed the connection."); // waits its backoff, never a tight loop
        synchronized (lock) { links.put(fp, next, version); }
        if (next.isClosed()) proxy.channelClosed(next);
    }

    private void pause(long ms) {
        synchronized (lock) {
            if (!wake && !stopped) try { lock.wait(ms); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            wake = false;
        }
    }

    private String lastStatus = "";
    private void say(String text, boolean connected) {
        if (stopped || text.equals(lastStatus)) return; // a stopped link (company switch, forget) never speaks over the next one
        lastStatus = text;
        status.changed(text, connected);
    }

    /** The PC the page uses now (for the picker, the status line and tests), or null. */
    public String pc() { return links.usedPc(); }

    /** This phone's own fingerprint. */
    public String self() { return Crypto.fingerprint(Crypto.ed25519Public(seed)); }

    public int openStreams() { return proxy == null ? 0 : proxy.openStreams(); }
}
