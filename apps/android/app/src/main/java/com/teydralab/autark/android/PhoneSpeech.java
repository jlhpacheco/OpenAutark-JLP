// Owns: the phone's own voice for the page (B-084 decision 5) – Android's TextToSpeech behind the port's 'speak' and
// 'stopSpeech', used when the PC's voice is unavailable and the WebView has no speechSynthesis – and for the bubble's
// call (phoneuse/BubbleCall, its own instance). Lines queue in order; each line reports done (spoken, failed or stopped)
// with its id, so the page's queue never waits forever. The engine starts on the first line. Owner 19.11.2026 ("klingt
// halt nicht gut"): Google's engine when the phone has it (Samsung phones default to their own), else the phone's
// default engine; per language the installed voice that needs no network with the highest quality (the line's own
// country first, then the lowest latency), at the normal rate. Never: records, decides what is read, or keeps text after it was spoken.
package com.teydralab.autark.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class PhoneSpeech {
    /** A line ended (spoken, failed or stopped); called on the main thread. */
    public interface Done { void done(String id); }

    /** Google's engine: its offline voices sound far better than most phones' defaults. */
    private static final String GOOGLE = "com.google.android.tts";
    private final Context context;
    private final Done done;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String[]> waiting = new ArrayList<>();
    private TextToSpeech engine;
    private String engineName = GOOGLE;
    private String tuned; // the language tag the engine's voice is set for
    private boolean ready;
    private boolean missing; // no TTS engine on this phone: every line ends at once

    public PhoneSpeech(Context context, Done done) {
        this.context = context.getApplicationContext();
        this.done = done;
    }

    /** Queues one line; lang is a BCP 47 tag or null for the phone's language. Main thread. */
    public void speak(String id, String text, String lang) {
        if (id == null || text == null || text.trim().isEmpty() || missing) { if (id != null) done.done(id); return; }
        if (!ready) { waiting.add(new String[] { id, text, lang }); start(); return; }
        say(id, text, lang);
    }

    /** Ends the current line and drops the queue (each dropped line still reports done). */
    public void stop() {
        for (String[] line : waiting) done.done(line[0]);
        waiting.clear();
        if (engine != null && ready) engine.stop();
    }

    public void shutdown() {
        stop();
        if (engine != null) engine.shutdown();
        engine = null;
        ready = false;
    }

    private void start() {
        if (engine != null) return;
        String wanted = engineName;
        TextToSpeech[] made = new TextToSpeech[1];
        TextToSpeech.OnInitListener init = (status) -> main.post(() -> {
            if (engine != made[0]) return; // an engine shut down before it was ready never touches the next one
            if (status != TextToSpeech.SUCCESS) {
                engine.shutdown();
                engine = null;
                if (wanted != null) { engineName = null; start(); return; } // Google's engine failed: the phone's default
                missing = true;
                stop();
                return;
            }
            ready = true;
            tuned = null;
            engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { main.post(() -> done.done(id)); }
                @Override @SuppressWarnings("deprecation") public void onError(String id) { main.post(() -> done.done(id)); }
                @Override public void onError(String id, int code) { main.post(() -> done.done(id)); }
                @Override public void onStop(String id, boolean interrupted) { main.post(() -> done.done(id)); }
            });
            List<String[]> lines = new ArrayList<>(waiting);
            waiting.clear();
            for (String[] line : lines) say(line[0], line[1], line[2]);
        });
        // A named engine that is not installed falls back to the default one inside TextToSpeech itself.
        engine = made[0] = wanted == null ? new TextToSpeech(context, init) : new TextToSpeech(context, init, wanted);
    }

    private void say(String id, String text, String lang) {
        Locale locale = lang == null || lang.isEmpty() ? Locale.getDefault() : Locale.forLanguageTag(lang);
        String tag = locale.toLanguageTag();
        if (!tag.equals(tuned)) { tune(locale); tuned = tag; }
        String line = text.length() > TextToSpeech.getMaxSpeechInputLength() ? text.substring(0, TextToSpeech.getMaxSpeechInputLength()) : text;
        if (engine.speak(line, TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) done.done(id);
    }

    /** The best installed offline voice of the locale's language; without one, the language as the engine picks it. */
    private void tune(Locale locale) {
        String country = locale.getCountry();
        if (country.isEmpty() && Locale.getDefault().getLanguage().equals(locale.getLanguage())) country = Locale.getDefault().getCountry();
        Voice best = null;
        try {
            Set<Voice> voices = engine.getVoices();
            if (voices != null) for (Voice voice : voices) {
                Locale of = voice.getLocale();
                Set<String> features = voice.getFeatures();
                if (of == null || !of.getLanguage().equals(locale.getLanguage()) || voice.isNetworkConnectionRequired()) continue;
                if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                if (best == null || better(voice, best, country)) best = voice;
            }
        } catch (RuntimeException engineFault) { best = null; } // an engine's broken voice list: the language as before
        boolean set = false;
        try { set = best != null && engine.setVoice(best) == TextToSpeech.SUCCESS; } catch (RuntimeException engineFault) { /* below */ }
        if (!set && engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) engine.setLanguage(locale);
        engine.setSpeechRate(1.0f);
    }

    private static boolean better(Voice a, Voice b, String country) {
        boolean aHome = country.equalsIgnoreCase(a.getLocale().getCountry()), bHome = country.equalsIgnoreCase(b.getLocale().getCountry());
        if (aHome != bHome) return aHome;
        if (a.getQuality() != b.getQuality()) return a.getQuality() > b.getQuality();
        return a.getLatency() < b.getLatency();
    }
}
