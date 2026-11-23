// Owns: who has the phone while the AI uses it (owner 10.11.2026 16:18, 15.11.2026 F16, 20.11.2026) – three states, kept
// apart: active (the AI's steps run), paused and ended. Only the person's own buttons in the bubble change it: their Pause
// holds until their Continue; their ✕ ends the job: its steps are refused for good, waiting ones included. Their ✓ to the
// AI's question (phone.say ask, agreed) makes that job active, also after Pause or ✕. A touch or typing of the person on
// the screen changes nothing here (owner 20.11.2026: "dass ich klicken kann und da kann sie einfach weitermachen"): the
// AI's next look at the screen shows what their touch changed.
// A job is the PC's run (the request's `job`); every job the person ended stays refused, also after a newer job ran
// (the last ENDED_KEPT of them). A PC without job ids (older desktop) gets one job per session, which ends SESSION_MS
// after the last step. The refusals are facts in the AI's own view with its next step. Pure Java, no Android:
// UseService asks it before every step and tells it about the person's buttons and answers; UseBubble shows it.
// Never: lets a step run while paused or ended, or lifts the person's Pause or ✕ by itself.
package com.teydralab.autark.android.phoneuse;

import java.util.LinkedHashSet;
import java.util.Set;

final class UseState {
    enum Mode { ACTIVE, PAUSED, ENDED }

    /** A refused step: `code` and the words the AI reads (phoneUse.reply's error). */
    static final class Refusal {
        final String code;
        final String message;
        Refusal(String code, String message) { this.code = code; this.message = message; }
    }

    /** Without a job id, a pause in steps this long starts a new job (ended no longer applies). */
    static final long SESSION_MS = 5 * 60_000;
    /** How many ended jobs are remembered (a late step of an older one is still refused). */
    static final int ENDED_KEPT = 64;

    static final String PAUSED_PERSON = "The person paused my phone use with Pause and has the phone; this step did not run. "
            + "My task stays: phone use goes on when they tap Continue in the bubble, or when they answer ✓ to my question "
            + "(phone.say with ask: true). Meanwhile I go on with other work.";
    static final String ENDED = "The person ended my phone use for this task with ✕; this step did not run, and the phone "
            + "stays theirs for this task. I finish it another way, or tell them in the chat what is left on the phone.";

    private Mode mode = Mode.ACTIVE;
    private String job;
    private final Set<String> endedJobs = new LinkedHashSet<>();
    private boolean endedWithoutJob;
    private long lastStep = Long.MIN_VALUE / 2;

    synchronized Mode mode() { return mode; }

    /** Before each step: null lets it run; else why not. `job` may be null (a PC without job ids). */
    synchronized Refusal step(String job, long now) {
        String key = job != null && !job.isEmpty() ? job : null;
        boolean sameSession = now - lastStep <= SESSION_MS;
        if (key == null && !sameSession) endedWithoutJob = false; // a quiet session: an older PC's next job
        boolean ended = key != null ? endedJobs.contains(key) : endedWithoutJob;
        if (ended) { lastStep = now; return new Refusal("ended", ENDED); }
        if (mode == Mode.ENDED) mode = Mode.ACTIVE; // a new job: the ✕ was for the one before
        this.job = key;
        lastStep = now;
        if (mode == Mode.PAUSED) return new Refusal("paused", PAUSED_PERSON);
        return null;
    }

    /** The person's Pause in the bubble: it holds until Continue. */
    synchronized boolean pause() {
        if (mode != Mode.ACTIVE) return false;
        mode = Mode.PAUSED;
        return true;
    }

    /** The person's ✓ to the AI's question for `job`: phone use is active for that job, after a Pause or ✕ too. */
    synchronized void agreed(String job, long now) {
        String key = job != null && !job.isEmpty() ? job : null;
        if (key != null) endedJobs.remove(key); else endedWithoutJob = false;
        this.job = key;
        mode = Mode.ACTIVE;
        lastStep = now;
    }

    /** The PC's run `job` is over (owner 19.11.2026): its session ends; the person's own Pause and ✕ stay as they are. */
    synchronized void finished(String job) {
        String key = job != null && !job.isEmpty() ? job : null;
        if (key != null && this.job != null && !key.equals(this.job)) return;
        lastStep = Long.MIN_VALUE / 2;
    }

    /** The person's Continue: the AI may go on with the same job. */
    synchronized boolean resume() {
        if (mode != Mode.PAUSED) return false;
        mode = Mode.ACTIVE;
        return true;
    }

    /** The person's ✕: the current job ends for good (from active or paused). */
    synchronized boolean end() {
        if (mode == Mode.ENDED) return false;
        mode = Mode.ENDED;
        if (job == null) endedWithoutJob = true;
        else {
            endedJobs.add(job);
            if (endedJobs.size() > ENDED_KEPT) endedJobs.remove(endedJobs.iterator().next());
        }
        return true;
    }

    /** Why a running step stopped part-way (the person tapped Pause or ✕ while it ran). */
    synchronized Refusal midStep() {
        if (mode == Mode.ENDED) return new Refusal("ended", "The person ended my phone use for this task with ✕ while this step "
                + "ran; it stopped part-way, and the phone stays theirs for this task. I finish it another way, or tell them in "
                + "the chat what is left on the phone.");
        return new Refusal("paused", "The person paused my phone use with Pause while this step ran, so it stopped part-way. My "
                + "task stays: it goes on when they tap Continue, or answer ✓ to my phone.say question; then I look at the "
                + "screen again before the next step. Meanwhile I go on with other work.");
    }

    /** True while a step may act (checked again between a step's parts, e.g. lines of typed text). */
    synchronized boolean acting() { return mode == Mode.ACTIVE; }
}
