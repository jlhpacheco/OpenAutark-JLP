// Owns: whether a failed call proves the PC's socket alive, and the timings of the ping before a send. No automatic retry
// lives here: the link's address does not name the PC (the company proxy can switch its target), so a draft that did not
// arrive stays in the panel and goes out again only when the person sends it. Pure, so a host test pins it. Never: Android classes.
package com.teydralab.autark.android.phoneuse;

final class Resend {
    /** A short ping before sending: no answer within this and the socket counts as half dead. */
    static final long PING_MS = 5_000;

    /** Whether a call's failure shows the socket lives: the PC answered with a refusal. Late or "not connected" does not. */
    static boolean provesAlive(boolean late, String message) {
        return !late && !"Not connected to your PC right now.".equals(message);
    }
}
