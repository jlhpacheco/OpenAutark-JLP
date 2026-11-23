// Owns: the website APK's update check (B-078, D18; Android 0.3.6) – in the release build, at start and on return at most
// once a minute (UpdateRelease.INTERVAL_MS, owner 19.11.2026: every opening; at once when the clock went back), it reads latest-android.json (full) or latest-android-lite.json (Lite)
// of the newest public release (github.com/teydra/OpenAutark: {versionCode, versionName, url, sha256, bytes, signer}); a
// newer versionCode shows the update line at the top (UpdateBar) of the screen on display when the answer arrives, until
// it is installed. Owner 10.11.2026 ("automatisch downloaden … kein Aufwand"): once the person allowed Autark to install
// updates, a newer release downloads and installs by itself (UpdateRelease.automatic – SelfUpdate; Android installs at once
// where it lets an app update itself, else its one confirm dialog); otherwise the line's "Update" does it. The
// found release is remembered, so the line is there at once on the next start, even offline; after a failed download it
// is forgotten, and "Try again" reads the feed anew before it downloads.
// An install from Google Play and the Play build read no feed: Play updates them itself, and a GitHub release says nothing
// about what Play offers (UpdateRelease.source). Their line, as often as a feed check, is the neutral "Check in Google
// Play", which opens Autark's Play page – no version, no "available".
// Never: installs anything but through SelfUpdate's checked session, or tells a Play install or the Play build about a
// GitHub release.
package com.teydralab.autark.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.teydralab.autark.android.relay.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

final class UpdateCheck {
    private static final int MAX_BYTES = 16 * 1024;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile boolean fetching;
    /** "Try again" waits for the next answer: a release found downloads at once. Main thread only. */
    private static boolean retry;

    private UpdateCheck() {}

    /** At start and on return: shows a remembered newer release at once and looks for a new one when it is time. */
    static void start(Activity activity, UpdateBar bar) {
        if ((activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) return; // the preview build updates by hand
        SharedPreferences preferences = preferences(activity);
        if (UpdateRelease.source(installer(activity), SelfUpdate.BUILT) == UpdateRelease.Source.PLAY) {
            if (preferences.contains("release")) preferences.edit().remove("release").apply(); // from the feed before: no news from Play
            long now = System.currentTimeMillis();
            if (UpdateRelease.due(preferences.getLong("playShownAt", 0), now)) { // as often as a feed check, no version claimed
                preferences.edit().putLong("playShownAt", now).apply();
                bar.step(UpdateRelease.PLAY_LINE, -1, UpdateRelease.PLAY_ACTION, () -> openPlay(activity));
            }
            return;
        }
        if (SelfUpdate.busy()) { SelfUpdate.attach(activity, bar::step); return; }
        long installed = installedCode(activity);
        boolean lite = lite(activity);
        Map<String, Object> known = UpdateRelease.newer(preferences.getString("release", ""), installed, lite);
        if (known != null) present(activity, bar, known);
        else if (preferences.contains("release")) preferences.edit().remove("release").apply(); // installed now
        if (!fetching && UpdateRelease.due(preferences.getLong("checkedAt", 0), System.currentTimeMillis())) look(activity, installed, lite);
    }

    /** "Try again" after a failed update: the release may have moved on, so the feed is read anew, and a release found
     * downloads at once on the screen shown then. */
    static void again() {
        MainActivity shown = MainActivity.shown();
        if (shown == null || shown.isDestroyed()) return;
        forget(shown);
        retry = true;
        shown.updates().step("Looking for the update…", -1, null, null);
        if (!fetching) look(shown, installedCode(shown), lite(shown));
    }

    /** Forgets the remembered release and when the feed was read, so the next start reads it anew (a download failed). */
    static void forget(Context context) {
        preferences(context).edit().remove("release").remove("checkedAt").apply();
    }

    private static void look(Context context, long installed, boolean lite) {
        SharedPreferences preferences = preferences(context);
        fetching = true;
        new Thread(() -> {
            Map<String, Object> release = null;
            String why = "No newer Autark is out.";
            try {
                String json = fetch(UpdateRelease.feed(lite));
                preferences.edit().putLong("checkedAt", System.currentTimeMillis()).apply();
                release = UpdateRelease.newer(json, installed, lite);
                if (release != null) preferences.edit().putString("release", json).apply();
            } catch (IOException | RuntimeException error) {
                why = "The update could not be loaded right now."; // offline or no feed yet: the next start looks again
            } finally {
                fetching = false;
            }
            Map<String, Object> found = release;
            String line = why;
            MAIN.post(() -> deliver(found, line));
        }, "autark-update").start();
    }

    /** The answer goes to the screen shown now – a recreated activity's, never the destroyed one that asked. */
    private static void deliver(Map<String, Object> release, String why) {
        boolean wanted = retry;
        retry = false;
        MainActivity shown = MainActivity.shown();
        if (shown == null || shown.isFinishing() || shown.isDestroyed() || SelfUpdate.busy()) return; // the next start shows what is remembered
        if (release != null && wanted && UpdateRelease.route(release) == UpdateRelease.Route.DOWNLOAD) SelfUpdate.start(shown, release, shown.updates()::step, UpdateCheck::again);
        else if (release != null) present(shown, shown.updates(), release);
        else if (wanted) shown.updates().step(why, -1, "Try again", UpdateCheck::again);
    }

    /** A newer release on screen: it downloads and installs by itself when it may (UpdateRelease.automatic; the try is
     * remembered per version), else the update line offers it. */
    private static void present(Activity activity, UpdateBar bar, Map<String, Object> release) {
        SharedPreferences preferences = preferences(activity);
        long now = System.currentTimeMillis();
        if (!UpdateRelease.automatic(release, canInstall(activity), preferences.getLong("autoCode", -1), preferences.getLong("autoAt", 0), now)) {
            offer(activity, bar, release);
            return;
        }
        preferences.edit().putLong("autoCode", Json.num(release, "versionCode", -1)).putLong("autoAt", now).apply();
        SelfUpdate.start(activity, release, bar::step, UpdateCheck::again);
    }

    /** True when Android already lets Autark install packages ("Install unknown apps" for Autark, allowed once). */
    static boolean canInstall(Activity activity) {
        try { return Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls(); }
        catch (RuntimeException error) { return false; }
    }

    /** The update line for this release: the app's own download, or the APK's address for a release without checks. */
    private static void offer(Activity activity, UpdateBar bar, Map<String, Object> release) {
        String name = "Autark " + (Json.str(release, "versionName") == null ? "" : Json.str(release, "versionName") + " ");
        if (UpdateRelease.route(release) == UpdateRelease.Route.DOWNLOAD) bar.step(name + "is available", -1, "Update", () -> SelfUpdate.start(activity, release, bar::step, UpdateCheck::again));
        else bar.step(name + "is available", -1, "Update", () -> openBrowser(activity, Json.str(release, "url")));
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences("update", Context.MODE_PRIVATE);
    }

    private static boolean lite(Context context) { return context.getResources().getBoolean(R.bool.lite_updates); }

    private static void openBrowser(Activity activity, String url) {
        try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (RuntimeException error) { /* no browser */ }
    }

    /** Autark's page in the Play app (there Play says whether it has an update), else in the browser. */
    private static void openPlay(Activity activity) {
        String id = activity.getPackageName();
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + id)).setPackage(InstallSource.PLAY_STORE));
        } catch (ActivityNotFoundException error) {
            try { activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + id))); }
            catch (ActivityNotFoundException none) { /* neither Play nor a browser */ }
        }
    }

    /** The package that installed this app (com.android.vending for Google Play), or null when unknown (adb, a file manager). */
    static String installer(Activity activity) {
        try {
            if (Build.VERSION.SDK_INT >= 30) return activity.getPackageManager().getInstallSourceInfo(activity.getPackageName()).getInstallingPackageName();
            return legacyInstaller(activity);
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static String legacyInstaller(Activity activity) { return activity.getPackageManager().getInstallerPackageName(activity.getPackageName()); }

    static long installedCode(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : legacyCode(info);
        } catch (PackageManager.NameNotFoundException error) {
            return Long.MAX_VALUE;
        }
    }

    /** The installed versionName (for the web view's user agent), or "" when unknown. */
    static String installedName(Activity activity) {
        try { String name = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; return name == null ? "" : name; }
        catch (PackageManager.NameNotFoundException error) { return ""; }
    }

    @SuppressWarnings("deprecation")
    private static long legacyCode(PackageInfo info) { return info.versionCode; }

    private static String fetch(String feed) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(feed).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setInstanceFollowRedirects(true);
        try (InputStream in = connection.getInputStream()) {
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_BYTES) throw new IOException("too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }
}
