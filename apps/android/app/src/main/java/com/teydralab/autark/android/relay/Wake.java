// Owns: waking a PC of mine whose Autark app is closed, from this phone (W, 19.11.2026 – owner: "vom Handy … auch
// erwachen lassen. Auch wenn die App komplett zu ist"): the PC's wake helper waits at the meeting server under its own key
// (desktop runtime/devices/sleeper.ts); this phone finds it under that key's Remote ID and sends one sealed request
// {op:'wake', at, nonce, sig} – the signature by this phone's device key over "wf-wake-v1|<helper fp>|<helper box>|<at>|<nonce>",
// byte for byte the desktop's shared/model/wake.ts wakeText (vector in test/relay/WakeTest.java and the desktop's
// test/unit/hosted/phone-wake.test.ts). The helper takes it because the PC pinned my phones in its wake file.
// Never: keeps a key, wakes a helper other than the one asked for, or needs a PC online.
package com.teydralab.autark.android.relay;

import java.io.IOException;
import java.util.List;
import java.util.Map;

public final class Wake {
    private Wake() {}

    /** How long the helper's answer may take (as the desktop's WAKE_REPLY_MS). */
    static final long REPLY_MS = 10_000;

    /** The text a waker signs. */
    public static String text(String wakeFp, String box, long at, String nonce) {
        return "wf-wake-v1|" + wakeFp + "|" + box + "|" + at + "|" + nonce;
    }

    /** The wake body for the helper session found (its fingerprint and box), signed with this phone's key. */
    public static Map<String, Object> body(byte[] seed, String wakeFp, String box, long at, String nonce) {
        return Json.map("op", "wake", "at", at, "nonce", nonce, "sig", Crypto.b64url(Crypto.sign(seed, Crypto.utf8(text(wakeFp, box, at, nonce)))));
    }

    /** One wake of the PC whose helper key is `wakePub` (base64url), named `name` in the errors, through `link`. */
    public static void send(RelayLink link, byte[] seed, String wakePub, String name, long now) throws IOException {
        byte[] key;
        try { key = wakePub == null ? new byte[0] : Crypto.fromB64url(wakePub); } catch (IllegalArgumentException error) { key = new byte[0]; }
        if (key.length != 32) throw new IOException(name + " runs an Autark that cannot be woken yet – start it there once.");
        String wakeFp = Crypto.fingerprint(key);
        RelayLink.Found helper = null;
        List<RelayLink.Found> found = link.find(Crypto.remoteId(wakeFp));
        for (RelayLink.Found entry : found) if (entry.fingerprint.equals(wakeFp)) helper = entry;
        if (helper == null) throw new IOException(name + " is not waiting at the meeting server – the PC is off or asleep, has no internet, or its app was not closed from the app.");
        Map<String, Object> reply = link.request(helper, body(seed, wakeFp, helper.box, now, Crypto.b64url(Crypto.random(18))), REPLY_MS);
        if (!Boolean.TRUE.equals(reply.get("ok"))) throw new IOException(name + " did not take the wake from this phone – its app was closed before it knew this phone. Wake it from another PC, or start it there once.");
    }
}
