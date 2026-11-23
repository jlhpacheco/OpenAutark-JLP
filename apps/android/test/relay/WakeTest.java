// Owns: the phone's wake (W, 19.11.2026): relay/Wake.java signs exactly the desktop's wake text – the vector below is
// the one the desktop's test/unit/hosted/phone-wake.test.ts checks for the PC (node) and the iPhone web app (WebCrypto) –
// and the wiring from the page's 'wake' to the meeting-server link, read from the sources (they need Android to run).
// Never: a device test (a real phone waking a real closed PC is checked by hand).
package com.teydralab.autark.android.relay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Map;

public final class WakeTest {
    private static int assertions;

    public static void main(String[] args) throws Exception {
        byte[] seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // RFC 8032 7.1 TEST 1
        String fp = "a".repeat(64);
        String box = Crypto.b64url(filled(32, (byte) 1));
        equal("wf-wake-v1|" + fp + "|AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE|1763500000000|wakewakewakewake0001", Wake.text(fp, box, 1_763_500_000_000L, "wakewakewakewake0001"));
        Map<String, Object> body = Wake.body(seed, fp, box, 1_763_500_000_000L, "wakewakewakewake0001");
        equal("tSWuVIlhc3dU7NWSk-9BKhQAxIivuIUmDLX-XM71H6ZAX5bKyPsPkz6xzMlm_uvLzuGOrK1OlYPKof3Sv19DAA", (String) body.get("sig"));
        equal("{\"op\":\"wake\",\"at\":1763500000000,\"nonce\":\"wakewakewakewake0001\",\"sig\":\"" + body.get("sig") + "\"}", Json.write(body));
        check(Crypto.verify(Crypto.ed25519Public(seed), Crypto.utf8(Wake.text(fp, box, 1_763_500_000_000L, "wakewakewakewake0001")), Crypto.fromB64url((String) body.get("sig"))));

        String port = source("NativePort.java");
        check(port.contains("case \"wake\": { String id = text(in, \"id\"); if (id != null) listener.wake(id, text(in, \"key\"), text(in, \"name\")); break; }"), "the page's wake reaches the activity");
        check(port.contains(".put(\"wake\", true)") && port.contains("put(\"t\", \"woken\").put(\"id\", id)"), "'status' says the app wakes; the answer is 'woken'");
        String main = source("MainActivity.java");
        check(main.contains("else link.wake(key, name, (error) -> port.woken(id, error));"), "the activity hands it to the company's link");
        String link = source("CompanyLink.java");
        int wake = link.indexOf("void wake(String key, String name");
        check(wake > 0 && link.indexOf("new Thread(", wake) > wake && link.indexOf("connection.wake(key,", wake) > wake, "the wake runs off the main thread");
        String connection = source("relay/PhoneConnection.java");
        check(connection.contains("Wake.send(current, seed, wakePub, name, System.currentTimeMillis());"), "through the connection's own meeting-server link and key");
        System.out.println(assertions + " wake assertions passed.");
    }

    private static String source(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get(System.getProperty("autark.android"), "app/src/main/java/com/teydralab/autark/android", name)), StandardCharsets.UTF_8);
    }

    private static byte[] filled(int length, byte value) { byte[] out = new byte[length]; java.util.Arrays.fill(out, value); return out; }

    private static byte[] hex(String text) {
        byte[] out = new byte[text.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(text.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static void check(boolean value) { check(value, "check failed"); }
    private static void check(boolean value, String what) { assertions++; if (!value) throw new AssertionError(what); }
    private static void equal(String expected, String actual) { assertions++; if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual); }
}
