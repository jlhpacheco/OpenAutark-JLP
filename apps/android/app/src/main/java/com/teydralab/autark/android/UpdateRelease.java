// Owns: channel-specific APK update feeds, which installs read them at all (website APKs; Google Play updates its own),
// release selection, when the feed is due again, when an update downloads by itself, and the progress and integrity
// rules of the in-app download – all testable without Android. Owner 10.11.2026: an update downloads by itself, no
// searching for the right file (.local/android-autoupdate/OWNER-2026-11-10.md).
// Never: offers a full APK to a Lite client, takes a GitHub release as evidence of Google Play, or installs an update.
package com.teydralab.autark.android;

import com.teydralab.autark.android.relay.Json;
import java.util.Locale;
import java.util.Map;

final class UpdateRelease {
    private static final String BASE = "https://github.com/teydra/OpenAutark/";
    /** An APK larger than this is no Autark update (the app is about 4 MB). */
    static final long MAX_APK_BYTES = 64L * 1024 * 1024;
    /** The feed is read on start and on every return to the app, at most this often: a fix reaches the phone the next time
     * the person opens Autark, not hours later (the feed is a few hundred bytes). Owner 19.11.2026: a release published
     * minutes ago showed no line – every opening reads it, once a minute at most. */
    static final long INTERVAL_MS = 60_000L;
    /** A version whose automatic try failed or was cancelled downloads by itself again only after this long; "Update" and
     * "Try again" stay at hand meanwhile. */
    static final long AUTO_RETRY_MS = 6 * 60 * 60_000L;

    /** Where this install learns about updates: the release feed (a website APK), or Google Play, which updates its
     * installs itself and is the only source of what Play offers – the GitHub feed says nothing about Play. */
    enum Source { FEED, PLAY }

    /** The Play source's line: a way into Google Play that claims no version and no availability (Play alone knows). */
    static final String PLAY_LINE = "Google Play keeps Autark up to date";
    static final String PLAY_ACTION = "Check in Google Play";

    /** How a feed release reaches this install: downloaded and installed by the app, or (a release without SHA-256 and
     * size, as before 0.3.6) as the APK's address in the browser. */
    enum Route { DOWNLOAD, BROWSER }

    private UpdateRelease() {}

    /** A website APK not installed by Google Play reads the feed; the Play build and every Play install do not. */
    static Source source(String installer, boolean selfUpdateBuilt) {
        return selfUpdateBuilt && InstallSource.selfUpdates(installer) ? Source.FEED : Source.PLAY;
    }

    /** True when the feed is to be read again: INTERVAL_MS after the last read, or when the clock went back before it. */
    static boolean due(long checkedAt, long now) {
        return now < checkedAt || now - checkedAt >= INTERVAL_MS;
    }

    static String feed(boolean lite) {
        return BASE + "releases/latest/download/latest-android" + (lite ? "-lite" : "") + ".json";
    }

    static Map<String, Object> newer(String json, long installed, boolean lite) {
        Map<String, Object> release;
        try { release = Json.object(json); } catch (IllegalArgumentException error) { return null; }
        String url = Json.str(release, "url");
        if (Json.num(release, "versionCode", -1) <= installed || url == null || !url.startsWith(BASE)) return null;
        if (lite && (!"lite".equals(Json.str(release, "channel")) || !url.endsWith("/autark-android-lite.apk"))) return null;
        if (!lite && "lite".equals(Json.str(release, "channel"))) return null;
        return release;
    }

    /** A website APK downloads its update itself when the release names the file's SHA-256 and size, which the download
     * is checked against; otherwise the browser opens the APK's address. */
    static Route route(Map<String, Object> release) {
        return sha256(release) != null && bytes(release) > 0 ? Route.DOWNLOAD : Route.BROWSER;
    }

    /** True when this release downloads and installs by itself, without a tap: the app fetches its updates itself (route
     * DOWNLOAD), Android already lets Autark install them (the person allowed it once), and this version's own automatic
     * try is not within the last AUTO_RETRY_MS (a clock set back allows it again). */
    static boolean automatic(Map<String, Object> release, boolean canInstall, long triedCode, long triedAt, long now) {
        if (release == null || !canInstall || route(release) != Route.DOWNLOAD) return false;
        return Json.num(release, "versionCode", -1) != triedCode || now < triedAt || now - triedAt >= AUTO_RETRY_MS;
    }

    /** The release's lower-case SHA-256 (64 hex characters), else null. */
    static String sha256(Map<String, Object> release) {
        String value = release == null ? null : Json.str(release, "sha256");
        if (value == null) return null;
        value = value.toLowerCase(Locale.ROOT);
        return value.matches("[0-9a-f]{64}") ? value : null;
    }

    /** The APK's announced size in bytes, or -1 when it is missing or implausible. */
    static long bytes(Map<String, Object> release) {
        long value = release == null ? -1 : Json.num(release, "bytes", -1);
        return value > 0 && value <= MAX_APK_BYTES ? value : -1;
    }

    /** Whole percent 0–100 of a download (0 while the size is unknown). */
    static int percent(long read, long total) {
        if (total <= 0 || read <= 0) return 0;
        return (int) Math.min(100, read * 100 / total);
    }

    /** True when the downloaded bytes are exactly the announced APK. */
    static boolean verified(Map<String, Object> release, String downloadedSha256, long downloadedBytes) {
        String expected = sha256(release);
        return expected != null && expected.equals(downloadedSha256) && downloadedBytes == bytes(release);
    }

    static String hex(byte[] digest) {
        StringBuilder out = new StringBuilder(digest.length * 2);
        for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }
}
