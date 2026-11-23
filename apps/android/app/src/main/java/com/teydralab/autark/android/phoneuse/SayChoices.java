// Owns: the AI's buttons in the phone bubble (phone.say `buttons`, owner 19.11.2026: "sie kann Buttons spawnen, so viel
// wie sie will" – small ones right of the line, bigger ones under it as bubbles of their own) as pure rules: which labels
// are kept, which are small, and what a tap answers. ✕ is the bubble's own cell (it answers "no"), so a ✕ among the AI's
// labels is that cell, not a second one; ✓ answers "yes" and gives the AI the phone for its job (UseState.agreed); every
// other label answers itself. Pure Java (host tests). Never: invents a label or keeps more than MAX.
package com.teydralab.autark.android.phoneuse;

import java.util.ArrayList;
import java.util.List;

final class SayChoices {
    /** The most buttons one question carries. */
    static final int MAX = 8;
    /** The longest label (code points; longer ones are cut with "…"). */
    static final int LABEL_MAX = 40;
    /** A label this short sits in the bubble's row, right of the line. */
    static final int SMALL_MAX = 4;
    /** How many small buttons fit in the row beside the line; later small ones go under it with the big ones. */
    static final int ROW_MAX = 3;
    static final String YES = "✓";
    static final String NO = "✕";

    private SayChoices() {}

    /** The labels of a say: its `buttons` (a JSON array of strings), else ✓ for `ask`; empty for a plain line. ✕ is
     *  left out (the bubble's ✕ cell answers it). */
    static List<String> of(Object buttons, boolean ask) {
        List<String> out = new ArrayList<>();
        if (buttons instanceof List) {
            for (Object item : (List<?>) buttons) {
                if (!(item instanceof String) || out.size() >= MAX) continue;
                String label = cut(((String) item).replaceAll("\\s+", " ").trim());
                if (!label.isEmpty() && !label.equals(NO) && !out.contains(label)) out.add(label);
            }
            if (out.isEmpty() && !((List<?>) buttons).isEmpty()) return out; // only ✕: a question with the ✕ cell alone
        }
        if (out.isEmpty() && ask) out.add(YES);
        return out;
    }

    /** True when `buttons` asks a question even though no label stayed (the AI gave only ✕). */
    static boolean asks(Object buttons, boolean ask) {
        return ask || (buttons instanceof List && !((List<?>) buttons).isEmpty());
    }

    static boolean small(String label) { return label.codePointCount(0, label.length()) <= SMALL_MAX; }

    /** The labels in the row beside the line: the first ROW_MAX small ones, in their order. */
    static List<String> row(List<String> labels) {
        List<String> out = new ArrayList<>();
        for (String label : labels) if (small(label) && out.size() < ROW_MAX) out.add(label);
        return out;
    }

    /** The labels under the line, each a bubble of its own: everything not in the row, in order. */
    static List<String> below(List<String> labels) {
        List<String> row = row(labels);
        List<String> out = new ArrayList<>();
        for (String label : labels) if (!row.contains(label)) out.add(label);
        return out;
    }

    /** What a tap on `label` answers: ✓ "yes", ✕ "no", any other label itself. */
    static String answer(String label) {
        if (YES.equals(label)) return "yes";
        if (NO.equals(label)) return "no";
        return label;
    }

    private static String cut(String label) {
        if (label.codePointCount(0, label.length()) <= LABEL_MAX) return label;
        return label.substring(0, label.offsetByCodePoints(0, LABEL_MAX - 1)) + "…";
    }
}
