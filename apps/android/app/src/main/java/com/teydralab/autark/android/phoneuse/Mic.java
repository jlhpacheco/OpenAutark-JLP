// Owns: the bubble's microphone – 16 kHz mono PCM16 from Android's AudioRecord (the voice-recognition source: the
// phone's own noise handling for speech), read on a thread of its own and handed on block by block (SpokenAudio's
// format). One recording at a time per Mic; a microphone that stops answering (read fails: another app took it, the
// right went) tells the owner once (`lost`). Never: keeps audio, or records without the microphone right (start says false).
package com.teydralab.autark.android.phoneuse;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

final class Mic {
    /** Gets every block the microphone heard (the Mic's own thread). */
    interface Sink { void heard(short[] block, int count); }

    private static final int BLOCK = 1_024;
    private final Context context;
    private volatile boolean running;
    private Thread reader;

    Mic(Context context) { this.context = context; }

    /** Whether this app may record (the app asks for the right where the person sees why). */
    static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Starts recording into `sink`; false when the microphone cannot be opened (no right, taken by another app).
     *  `lost` runs once on the Mic's thread when the microphone stops answering while it records. */
    synchronized boolean start(Sink sink, Runnable lost) {
        if (running) return true;
        // The check stands here (not only in allowed()) so lint sees it before AudioRecord is built.
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        int min = AudioRecord.getMinBufferSize(SpokenAudio.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord record = null;
        try {
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SpokenAudio.RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, BLOCK * 8));
            if (record.getState() != AudioRecord.STATE_INITIALIZED) { record.release(); return false; }
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { record.release(); return false; } // another app holds it
        } catch (RuntimeException error) { // SecurityException included: the right went meanwhile
            if (record != null) record.release();
            return false;
        }
        running = true;
        AudioRecord mine = record;
        reader = new Thread(() -> {
            short[] block = new short[BLOCK];
            try {
                while (running) {
                    int count = mine.read(block, 0, BLOCK);
                    if (count < 0) { if (running) lost.run(); break; }
                    if (count > 0 && running) sink.heard(block, count);
                }
            } finally {
                try { mine.stop(); } catch (RuntimeException ignored) { /* already stopped */ }
                mine.release();
            }
        }, "autark-mic");
        reader.setDaemon(true);
        reader.start();
        return true;
    }

    /** Stops recording; returns once the last block was handed on (at most a moment). */
    void stop() {
        Thread thread;
        synchronized (this) {
            running = false;
            thread = reader;
            reader = null;
        }
        if (thread == null || thread == Thread.currentThread()) return;
        try { thread.join(500); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
    }
}
