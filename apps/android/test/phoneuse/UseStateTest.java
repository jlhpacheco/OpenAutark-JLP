// Owns: host checks of who has the phone (UseState, owner 10.11.2026 16:18, 15.11.2026 F16, 20.11.2026): only the
// person's buttons change it – Pause → holds until Continue; ✕ → no further step of that job (waiting ones too), a new
// job may use the phone; the person's ✓ to the AI's question opens the job again; a touch on the screen has no state to
// change (there is no touch-pause); the refusals the AI reads are facts with a next step, no "do not".
// Never: a device test (the bubble and Android's touch events are checked on a phone).
package com.teydralab.autark.android.phoneuse;

public final class UseStateTest {
    private static int assertions;

    private static void check(boolean ok, String what) {
        assertions++;
        if (!ok) throw new AssertionError(what);
    }

    private static String code(UseState.Refusal refusal) { return refusal == null ? "run" : refusal.code; }

    public static void main(String[] args) {
        explicitPauseThenContinue();
        endStopsTheJobForGood();
        endWithoutJobIds();
        lateStepOfEndedJobAfterNewerJob();
        personPauseHolds();
        agreedOpensTheJob();
        refusalsAreFacts();
        System.out.println("UseStateTest: " + assertions + " assertions passed");
    }

    private static void personPauseHolds() {
        UseState s = new UseState();
        s.step("run_l", 0);
        check(s.pause(), "the person's Pause");
        check(code(s.step("run_l", UseState.SESSION_MS * 100)).equals("paused"), "Pause holds however long");
        check(code(s.step("run_other", UseState.SESSION_MS * 100)).equals("paused"), "also for another job: the person has the phone");
        check(s.resume() && code(s.step("run_l", UseState.SESSION_MS * 101)).equals("run"), "Continue lifts it");
        UseState e = new UseState();
        e.step("run_n", 0);
        e.end();
        check(!e.pause() && !e.resume(), "ended stays ended: Pause and Continue change nothing");
        check(code(e.step("run_n", 50_000)).equals("ended"), "its steps stay refused");
    }

    private static void agreedOpensTheJob() {
        UseState s = new UseState();
        s.step("run_o", 0);
        s.pause();
        s.agreed("run_o", 1_000);
        check(s.acting() && code(s.step("run_o", 1_001)).equals("run"), "✓ to the AI's question ends the person's Pause for that job");
        s.end();
        check(code(s.step("run_o", 2_000)).equals("ended"), "✕ ends the job");
        s.agreed("run_o", 3_000);
        check(code(s.step("run_o", 3_001)).equals("run"), "✓ after ✕ opens that job again");
        UseState old = new UseState();
        old.step(null, 0);
        old.end();
        check(code(old.step(null, 1_000)).equals("ended"), "an older PC without job ids: ended within the session");
        old.agreed(null, 2_000);
        check(code(old.step(null, 2_001)).equals("run"), "and ✓ opens it again");
    }

    private static void refusalsAreFacts() {
        UseState s = new UseState();
        s.step("run_q", 0);
        s.pause();
        String held = s.midStep().message;
        s.end();
        String cut = s.midStep().message;
        for (String text : new String[] { UseState.PAUSED_PERSON, UseState.ENDED, held, cut }) {
            String lower = text.toLowerCase(java.util.Locale.ROOT);
            check(!lower.contains("do not") && !lower.contains("don't") && !lower.contains("never"), "a fact, no prohibition: " + text);
            check(text.contains(" I ") || text.startsWith("I "), "in the AI's own voice: " + text);
            check(!lower.contains("touch"), "no refusal speaks of a touch of the person: " + text);
        }
    }

    private static void explicitPauseThenContinue() {
        UseState s = new UseState();
        s.step("run_e", 0);
        check(s.pause(), "the person's Pause");
        check(s.mode() == UseState.Mode.PAUSED, "paused by the person");
        UseState.Refusal r = s.step("run_e", 1_000);
        check(code(r).equals("paused") && r.message.contains("Pause") && r.message.contains("Continue"), "the AI reads why and what lifts it");
        check(!s.pause(), "Pause twice changes nothing");
        check(s.resume(), "Continue");
        check(!s.resume(), "Continue while active changes nothing");
        check(code(s.step("run_e", 2_000)).equals("run"), "the job goes on");
    }

    private static void endStopsTheJobForGood() {
        UseState s = new UseState();
        s.step("run_f", 0);
        check(s.end(), "✕");
        check(!s.acting(), "the running step stops");
        check(code(s.midStep()).equals("ended"), "a cut step says ended");
        for (int i = 1; i <= 5; i++) check(code(s.step("run_f", i * 1_000)).equals("ended"), "every further step of that job is refused (" + i + ")");
        check(code(s.step("run_f", UseState.SESSION_MS * 10)).equals("ended"), "also much later: ✕ is for good for that job");
        check(!s.resume(), "Continue does not undo ✕");
        check(code(s.step("run_g", UseState.SESSION_MS * 10 + 1)).equals("run"), "a new job may use the phone");
        UseState p = new UseState();
        p.step("run_h", 0);
        p.pause();
        check(p.end(), "✕ while paused");
        check(code(p.step("run_h", 1_000)).equals("ended"), "ended, not paused");
    }

    private static void endWithoutJobIds() {
        UseState s = new UseState();
        s.step(null, 0);
        s.end();
        check(code(s.step(null, 60_000)).equals("ended"), "an older PC without job ids: refused within the session");
        check(code(s.step(null, 60_000 + UseState.SESSION_MS)).equals("ended"), "each refused try keeps the session");
        check(code(s.step(null, 60_000 + 2 * UseState.SESSION_MS + 1)).equals("run"), "after a quiet session a new job starts");
    }

    // Konrad's repro 10.11.2026 21:16: A, ✕, B, then a late step of A was let through.
    private static void lateStepOfEndedJobAfterNewerJob() {
        UseState s = new UseState();
        s.step("A", 0);
        s.end();
        check(code(s.step("A", 1)).equals("ended"), "A right after ✕ is refused");
        check(code(s.step("B", 2)).equals("run"), "a new job B may run");
        check(code(s.step("A", 3)).equals("ended"), "a late step of A stays refused after B");
        check(code(s.step("B", 4)).equals("run"), "B goes on");
        check(s.mode() == UseState.Mode.ACTIVE, "A's refusal does not touch B's state");
        s.end();
        check(code(s.step("B", 5)).equals("ended") && code(s.step("A", 6)).equals("ended"), "both ended jobs stay refused");
        check(code(s.step("C", 7)).equals("run"), "a third job may run");
        UseState many = new UseState();
        many.step("first", 0); many.end();
        for (int i = 0; i < UseState.ENDED_KEPT - 1; i++) { many.step("job" + i, i + 1); many.end(); }
        check(code(many.step("first", 1_000)).equals("ended"), "the oldest of ENDED_KEPT ended jobs is still refused");
    }

}
