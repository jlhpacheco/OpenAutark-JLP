// Owns: the phone's own hearing of a dictation piece (STIMME 21.11.2026, owner: "transcribing via Codex does not have to
// go over the PC"): the piece goes from the phone straight to the person's ChatGPT plan dictation endpoint – the PC's
// runtime/voice/plan-transcribe.ts request (one multipart POST: the file as it is, named dictation.<wav|ogg>, and the
// language hint the PC would send) – with the plan login the PC hands to this paired phone (voice.planLogin: access
// token, account id, expiry, hint). The PC hands it only to this app's native side: each ask carries `at` and `proof`,
// the phone's Ed25519 device key's signature of proofText (the page shares the device token but never the key). A page cannot make that request (chatgpt.com refuses other origins' preflight,
// measured 21.11.2026), so the app does it for the page (NativePort 'hear') and for the bubble's dictation (Dictation).
// The login stays in this process's memory, one per PC origin, until it expires (or the language asked changes); a 401
// asks the PC once for a fresh one (Codex refreshes it there) and tries again; a fresh login rejected too rests the
// direct way of that PC for REST_MS. Every other failure is Missed: the caller sends the piece the PC's way as before.
// Pure Java (the PC and HTTP behind interfaces), so a host test pins it (test/phoneuse/PlanHearingTest.java).
// Never: logs, shows or stores on disk a token or an account id; sends the audio or the token anywhere but the one
// endpoint; follows a redirect; refreshes a token itself.
package com.teydralab.autark.android.phoneuse;

import com.teydralab.autark.android.relay.Crypto;
import com.teydralab.autark.android.relay.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

public final class PlanHearing {
    public static final String ENDPOINT = "https://chatgpt.com/backend-api/transcribe";
    /** One request's limit, as the PC's (PLAN_TRANSCRIBE_MS). */
    static final int REQUEST_MS = 45_000;
    /** The PC's answer with a login; a fresh one waits for Codex's refresh there (up to 20 s). */
    static final long LOGIN_MS = 15_000;
    static final long FRESH_MS = 30_000;
    /** After a fresh login was rejected too, the direct way of that PC rests this long. */
    static final long REST_MS = 60 * 60_000;
    /** A login this close to its expiry is asked again. */
    static final long MARGIN_MS = 60_000;
    /** The endpoint takes 25 MB; the answer is read up to 1 MiB, a text up to 100 000 chars (as the PC). */
    static final int MAX_AUDIO = 25 * 1024 * 1024;
    private static final int MAX_ANSWER = 1024 * 1024;
    private static final int MAX_TEXT = 100_000;

    /** The piece was not heard here: the PC's way follows. The message is a short reason, never a value. */
    public static final class Missed extends Exception {
        private static final long serialVersionUID = 1L;
        Missed(String why) { super(why); }
    }

    /** The PC: its voice.planLogin answer (a map) for `language` (a tag or null), or Missed; and which PC it is. */
    interface Pc {
        Map<String, Object> login(String language, boolean fresh) throws Missed, InterruptedException;
        String place();
    }

    /** One POST and its answer. */
    interface Http { Reply post(String url, Map<String, String> headers, String contentType, byte[] body, int timeoutMs) throws IOException; }

    static final class Reply {
        final int status;
        final String body;
        Reply(int status, String body) { this.status = status; this.body = body; }
    }

    private static final class Login {
        final String place, asked, token, account, language;
        final long expires;
        Login(String place, String asked, String token, String account, String language, long expires) {
            this.place = place; this.asked = asked; this.token = token; this.account = account; this.language = language; this.expires = expires;
        }
    }

    /** Guarded by PlanHearing.class: the logins by PC origin, and until when a PC's direct way rests. */
    private static final Map<String, Login> logins = new LinkedHashMap<>();
    private static final Map<String, Long> resting = new LinkedHashMap<>();

    private final Pc pc;
    private final Http http;
    private final LongSupplier clock;

    PlanHearing(Pc pc, Http http, LongSupplier clock) { this.pc = pc; this.http = http; this.clock = clock; }

    /** The real endpoint and clock for the PC `pc` (UseLink.hearing: the phone's link to its PC). */
    static PlanHearing of(Pc pc) { return new PlanHearing(pc, PlanHearing::https, System::currentTimeMillis); }

    /** The piece's text ("" when no words were heard), heard by the plan from this phone; Missed otherwise. Not the main thread. */
    public String hear(byte[] audio, String mime, String language) throws Missed, InterruptedException {
        String name = "audio/ogg".equals(mime) ? "dictation.ogg" : "audio/wav".equals(mime) ? "dictation.wav" : null;
        if (name == null || audio == null || audio.length == 0 || audio.length > MAX_AUDIO) throw new Missed("not a dictation piece");
        String place = pc.place();
        if (place == null) throw new Missed("no PC");
        String asked = SpeechLang.valid(language);
        long now = clock.getAsLong();
        synchronized (PlanHearing.class) {
            Long until = resting.get(place);
            if (until != null && now < until) throw new Missed("resting");
        }
        Login login = login(place, asked, false, now);
        Reply reply = send(login, audio, mime, name);
        if (reply.status == 401) {
            forget(login);
            login = login(place, asked, true, now);
            reply = send(login, audio, mime, name);
            if (reply.status == 401) {
                forget(login);
                synchronized (PlanHearing.class) { resting.put(place, now + REST_MS); }
                throw new Missed("the plan refused the login");
            }
        }
        return text(reply, login.token);
    }

    /** The cached login of this PC for this language, or a new one from the PC (`fresh`: Codex refreshes first). */
    private Login login(String place, String asked, boolean fresh, long now) throws Missed, InterruptedException {
        if (!fresh) {
            synchronized (PlanHearing.class) {
                Login known = logins.get(place);
                if (known != null && known.expires - now > MARGIN_MS && same(known.asked, asked)) return known;
            }
        }
        Map<String, Object> answer = pc.login(asked, fresh);
        String token = Json.str(answer, "token");
        long expires = Json.num(answer, "expiresAt", -1);
        if (token == null || token.isEmpty() || !token.trim().equals(token) || token.matches(".*\\s.*") || expires - now <= MARGIN_MS) throw new Missed("no usable login");
        Login login = new Login(place, asked, token, Json.str(answer, "accountId"), Json.str(answer, "language"), expires);
        synchronized (PlanHearing.class) { logins.put(place, login); }
        return login;
    }

    private static void forget(Login login) {
        synchronized (PlanHearing.class) { if (logins.get(login.place) == login) logins.remove(login.place); }
    }

    private Reply send(Login login, byte[] audio, String mime, String name) throws Missed {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", "Bearer " + login.token);
        if (login.account != null && !login.account.isEmpty()) headers.put("ChatGPT-Account-Id", login.account);
        String boundary = "autark" + Long.toHexString(new SecureRandom().nextLong() & Long.MAX_VALUE);
        try {
            return http.post(ENDPOINT, headers, "multipart/form-data; boundary=" + boundary, multipart(boundary, audio, mime, name, login.language), REQUEST_MS);
        } catch (IOException failed) {
            throw new Missed("the plan was not reached");
        }
    }

    /** The form the PC's FormData sends: the file, then the language when there is one. */
    static byte[] multipart(String boundary, byte[] audio, String mime, String name, String language) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(audio.length + 512);
        write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
        out.write(audio, 0, audio.length);
        write(out, "\r\n");
        if (language != null && !language.isEmpty()) write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n" + language + "\r\n");
        write(out, "--" + boundary + "--\r\n");
        return out.toByteArray();
    }

    /** The answer's text, as the PC reads it: {text: string}; blank is ''. */
    static String text(Reply reply, String token) throws Missed {
        if (reply.status < 200 || reply.status > 299) throw new Missed("the plan answered " + reply.status);
        Object text;
        try { text = Json.object(reply.body == null ? "" : reply.body).get("text"); } catch (IllegalArgumentException notJson) { throw new Missed("not an answer"); }
        if (!(text instanceof String)) throw new Missed("no text");
        String value = ((String) text).trim();
        if (value.length() > MAX_TEXT || value.indexOf('\0') >= 0) throw new Missed("no usable text");
        return token == null || token.isEmpty() ? value : value.replace(token, "[redacted]");
    }

    /** What the device key signs for voice.planLogin (runtime/rpc/handlers/voice-plan.ts planProofText). */
    static String proofText(String deviceId, long at) { return "autark-plan-login\n" + deviceId + "\n" + at; }

    /** voice.planLogin's params: the language tag, fresh, and the device key's proof for `at`. */
    static Map<String, Object> loginParams(byte[] seed, String deviceId, long at, String language, boolean fresh) {
        Map<String, Object> params = new LinkedHashMap<>();
        if (language != null) params.put("language", language);
        if (fresh) params.put("fresh", true);
        params.put("at", at);
        params.put("proof", Crypto.b64url(Crypto.sign(seed, Crypto.utf8(proofText(deviceId, at)))));
        return params;
    }

    /** Tests: forget every login and rest. */
    static void forgetAll() {
        synchronized (PlanHearing.class) { logins.clear(); resting.clear(); }
    }

    private static boolean same(String a, String b) { return a == null ? b == null : a.equals(b); }

    private static void write(ByteArrayOutputStream out, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        out.write(bytes, 0, bytes.length);
    }

    /** The real request: HTTPS, no redirects, the answer read up to MAX_ANSWER. */
    private static Reply https(String url, Map<String, String> headers, String contentType, byte[] body, int timeoutMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(Math.min(timeoutMs, 15_000));
            connection.setReadTimeout(timeoutMs);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            connection.setRequestProperty("Content-Type", contentType);
            for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in == null) return new Reply(status, "");
            try (InputStream stream = in) {
                ByteArrayOutputStream answer = new ByteArrayOutputStream();
                byte[] chunk = new byte[16 * 1024];
                for (int read; (read = stream.read(chunk)) >= 0;) {
                    if (answer.size() + read > MAX_ANSWER) throw new IOException("answer too large");
                    answer.write(chunk, 0, read);
                }
                return new Reply(status, answer.toString("UTF-8"));
            }
        } finally {
            connection.disconnect();
        }
    }
}
