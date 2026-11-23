// Owns: host checks of the phone's own dictation hearing (PlanHearing, STIMME 21.11.2026): the request is the PC's
// (POST the endpoint, Bearer + ChatGPT-Account-Id, multipart file named dictation.<wav|ogg> with its type, then the PC's
// language hint), the login is asked once and kept per PC until it nears its expiry or the language changes, a 401 asks
// the PC for a fresh login once and tries again, a second 401 rests that PC's direct way for REST_MS, every other failure
// is Missed (a PC without a login, a 500, a broken answer, a format the endpoint is not sent), no words is "", and the
// token never appears in a text or a reason. The PC's login is asked with the device key's proof: the same signature the
// PC's test checks (test/unit/rpc/voice-plan-login.test.ts, seed 32 × 7). Never: the network or a real login (fakes).
package com.teydralab.autark.android.phoneuse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class PlanHearingTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    /** A fake PC: hands out logins tok-1, tok-2, … (or refuses), counts the asks. */
    private static final class Pc implements PlanHearing.Pc {
        final List<String> asks = new ArrayList<>();
        String place = "http://company-1.localhost:4711";
        boolean refuse;
        long expiresAt;
        Pc(long expiresAt) { this.expiresAt = expiresAt; }
        @Override public Map<String, Object> login(String language, boolean fresh) throws PlanHearing.Missed {
            asks.add((fresh ? "fresh " : "") + language);
            if (refuse) throw new PlanHearing.Missed("the PC gives no plan login");
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("token", "tok-" + asks.size());
            answer.put("accountId", "acct-test");
            answer.put("expiresAt", (double) expiresAt);
            if (language != null) answer.put("language", language.substring(0, 2));
            return answer;
        }
        @Override public String place() { return place; }
    }

    /** A fake endpoint: answers in turn, records each request. */
    private static final class Http implements PlanHearing.Http {
        final List<Integer> statuses = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
        final List<Map<String, String>> headers = new ArrayList<>();
        final List<String> sent = new ArrayList<>();
        final List<String> types = new ArrayList<>();
        final List<String> urls = new ArrayList<>();
        boolean down;
        Http answer(int status, String body) { statuses.add(status); bodies.add(body); return this; }
        @Override public PlanHearing.Reply post(String url, Map<String, String> head, String contentType, byte[] body, int timeoutMs) throws IOException {
            if (down) throw new IOException("offline");
            urls.add(url); headers.add(head); types.add(contentType); sent.add(new String(body, StandardCharsets.ISO_8859_1));
            int index = urls.size() - 1;
            return index < statuses.size() ? new PlanHearing.Reply(statuses.get(index), bodies.get(index)) : new PlanHearing.Reply(500, "");
        }
    }

    private static final long NOW = 1_800_000_000_000L;
    private static final byte[] WAV = { 'R', 'I', 'F', 'F', 1, 2, 3 };

    public static void main(String[] args) throws Exception {
        request();
        cached();
        refreshed();
        rests();
        missed();
        proof();
        System.out.println("PlanHearingTest: " + assertions + " assertions passed");
    }

    private static void request() throws Exception {
        PlanHearing.forgetAll();
        Pc pc = new Pc(NOW + 3_600_000);
        Http http = new Http().answer(200, "{\"text\":\"  Hallo Welt. \",\"asset_pointer\":\"x\"}");
        String text = new PlanHearing(pc, http, () -> NOW).hear(WAV, "audio/wav", "de-DE");
        check("Hallo Welt.".equals(text), "the plan's text, trimmed");
        check(http.urls.get(0).equals(PlanHearing.ENDPOINT), "the PC's endpoint");
        check("Bearer tok-1".equals(http.headers.get(0).get("Authorization")) && "acct-test".equals(http.headers.get(0).get("ChatGPT-Account-Id")), "the login in the headers");
        String type = http.types.get(0);
        check(type.startsWith("multipart/form-data; boundary="), "a multipart form");
        String boundary = type.substring(type.indexOf('=') + 1);
        String body = http.sent.get(0);
        check(body.startsWith("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"), "the file first, named as the PC names it");
        check(body.contains("name=\"language\"\r\n\r\nde\r\n") && body.endsWith("--" + boundary + "--\r\n"), "then the PC's language hint, then the end");
        check(pc.asks.equals(List.of("de-DE")), "the PC was asked once, with the person's tag");
        PlanHearing.forgetAll();
        Http ogg = new Http().answer(200, "{\"text\":\"   \"}");
        check("".equals(new PlanHearing(new Pc(NOW + 3_600_000), ogg, () -> NOW).hear(WAV, "audio/ogg", null)), "no words is a text");
        check(ogg.sent.get(0).contains("filename=\"dictation.ogg\"\r\nContent-Type: audio/ogg") && !ogg.sent.get(0).contains("name=\"language\""), "Ogg as it is; no hint, no field");
    }

    private static void cached() throws Exception {
        PlanHearing.forgetAll();
        Pc pc = new Pc(NOW + 3_600_000);
        Http http = new Http().answer(200, "{\"text\":\"a\"}").answer(200, "{\"text\":\"b\"}").answer(200, "{\"text\":\"c\"}").answer(200, "{\"text\":\"d\"}").answer(200, "{\"text\":\"e\"}");
        long[] now = { NOW };
        PlanHearing hearing = new PlanHearing(pc, http, () -> now[0]);
        hearing.hear(WAV, "audio/wav", "de");
        hearing.hear(WAV, "audio/wav", "de");
        check(pc.asks.size() == 1, "the login is kept");
        new PlanHearing(pc, http, () -> now[0]).hear(WAV, "audio/wav", "de");
        check(pc.asks.size() == 1, "kept for the whole app, not one hearing");
        hearing.hear(WAV, "audio/wav", "en");
        check(pc.asks.size() == 2, "another language: asked again (the PC's hint differs)");
        now[0] = NOW + 3_600_000 - PlanHearing.MARGIN_MS + 1;
        pc.expiresAt = NOW + 7_200_000; // the PC hands a newer login
        hearing.hear(WAV, "audio/wav", "en");
        check(pc.asks.size() == 3, "near its expiry: asked again");
        PlanHearing.forgetAll();
    }

    private static void refreshed() throws Exception {
        PlanHearing.forgetAll();
        Pc pc = new Pc(NOW + 3_600_000);
        Http http = new Http().answer(401, "{\"detail\":\"Unauthorized\"}").answer(200, "{\"text\":\"after the refresh\"}");
        check("after the refresh".equals(new PlanHearing(pc, http, () -> NOW).hear(WAV, "audio/wav", "de")), "one fresh login, one more try");
        check(pc.asks.equals(List.of("de", "fresh de")), "the PC was asked for a fresh one");
        check("Bearer tok-2".equals(http.headers.get(1).get("Authorization")), "the fresh token went");
        Http redacted = new Http().answer(200, "{\"text\":\"said tok-2 aloud\"}");
        check("said [redacted] aloud".equals(new PlanHearing(pc, redacted, () -> NOW).hear(WAV, "audio/wav", "de")), "the token never comes back as words");
    }

    private static void rests() throws Exception {
        PlanHearing.forgetAll();
        Pc pc = new Pc(NOW + 3_600_000);
        Http http = new Http().answer(401, "").answer(401, "").answer(200, "{\"text\":\"later\"}");
        long[] now = { NOW };
        PlanHearing hearing = new PlanHearing(pc, http, () -> now[0]);
        try { hearing.hear(WAV, "audio/wav", "de"); check(false, "a second 401 is Missed"); }
        catch (PlanHearing.Missed missed) { check(!missed.getMessage().contains("tok"), "the reason names no token"); }
        check(http.urls.size() == 2, "one retry, no loop");
        try { hearing.hear(WAV, "audio/wav", "de"); check(false, "resting"); } catch (PlanHearing.Missed missed) { check(http.urls.size() == 2 && pc.asks.size() == 2, "the resting way asks nobody"); }
        Pc other = new Pc(NOW + 3_600_000);
        other.place = "http://company-2.localhost:4712";
        check("later".equals(new PlanHearing(other, http, () -> now[0]).hear(WAV, "audio/wav", "de")), "another PC's way does not rest");
        now[0] = NOW + PlanHearing.REST_MS;
        pc.expiresAt = now[0] + 3_600_000;
        Http back = new Http().answer(200, "{\"text\":\"back\"}");
        check("back".equals(new PlanHearing(pc, back, () -> now[0]).hear(WAV, "audio/wav", "de")), "after REST_MS it tries again");
    }

    private static void missed() throws Exception {
        PlanHearing.forgetAll();
        Pc refusing = new Pc(NOW + 3_600_000);
        refusing.refuse = true;
        expectMissed(new PlanHearing(refusing, new Http().answer(200, "{\"text\":\"x\"}"), () -> NOW), "audio/wav", "a PC without a plan login");
        expectMissed(new PlanHearing(new Pc(NOW + 30_000), new Http().answer(200, "{\"text\":\"x\"}"), () -> NOW), "audio/wav", "a login about to expire");
        PlanHearing.forgetAll();
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), new Http().answer(500, "{}"), () -> NOW), "audio/wav", "a 500");
        PlanHearing.forgetAll();
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), new Http().answer(429, "{}"), () -> NOW), "audio/wav", "a limit");
        PlanHearing.forgetAll();
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), new Http().answer(200, "<html>"), () -> NOW), "audio/wav", "not JSON");
        PlanHearing.forgetAll();
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), new Http().answer(200, "{\"text\":5}"), () -> NOW), "audio/wav", "no text string");
        PlanHearing.forgetAll();
        Http down = new Http();
        down.down = true;
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), down, () -> NOW), "audio/wav", "no network");
        Http never = new Http();
        expectMissed(new PlanHearing(new Pc(NOW + 3_600_000), never, () -> NOW), "audio/webm", "a format the PC does not send");
        check(never.urls.isEmpty(), "nothing went out for it");
    }

    private static void proof() {
        byte[] seed = new byte[32];
        java.util.Arrays.fill(seed, (byte) 7);
        check("autark-plan-login\ndev_phone\n1800000000000".equals(PlanHearing.proofText("dev_phone", NOW)), "the signed text, as the PC's planProofText");
        Map<String, Object> params = PlanHearing.loginParams(seed, "dev_phone", NOW, "de", true);
        check("NHAmZpVGM9Iux17oMpmZVQhS8b6IzPZsrkIYi8qbOabNoAil2qgYaAbPepQM0xaOvJWGZBdlI9nJEHsyUQcjAg".equals(params.get("proof")), "the device key's signature: the PC test's vector");
        check(Long.valueOf(NOW).equals(params.get("at")) && "de".equals(params.get("language")) && Boolean.TRUE.equals(params.get("fresh")), "at, language and fresh go along");
        check(!PlanHearing.loginParams(seed, "dev_phone", NOW, null, false).containsKey("fresh"), "no fresh, no language: left out");
    }

    private static void expectMissed(PlanHearing hearing, String mime, String what) throws InterruptedException {
        try { hearing.hear(WAV, mime, "de"); check(false, what + ": Missed"); }
        catch (PlanHearing.Missed missed) { check(true, what); }
    }
}
