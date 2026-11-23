// Owns: the app's one own screen besides pairing – "Can't reach your PC right now" with the reason (a line the
// connection keeps updating), Try again and Choose PC (19.11.2026, D4: no Forget on this path – a PC out of reach is no
// reason to drop the pairing; Forget stays in the web UI's Settings › Devices); light or
// dark text like the system. Never: decides what Try again or Choose PC do (MainActivity), or polls.
package com.teydralab.autark.android;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

final class OfflineScreen {
    private OfflineScreen() {}

    /** Fills content; returns the reason's line for later connection texts. */
    static TextView show(Activity activity, FrameLayout content, String reason, Runnable retry, Runnable choosePc) {
        content.removeAllViews();
        float dp = activity.getResources().getDisplayMetrics().density;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(Math.round(24 * dp), Math.round(32 * dp), Math.round(24 * dp), Math.round(24 * dp));
        content.addView(form, new FrameLayout.LayoutParams(-1, -1));
        form.addView(text(activity, "Can't reach your PC right now", 20, dark, dp));
        TextView line = text(activity, reason, 15, dark, dp);
        line.setMinLines(3); // the connection's texts change here; nothing below moves
        form.addView(line);
        form.addView(button(activity, "Try again", retry));
        form.addView(button(activity, "Choose PC", choosePc));
        return line;
    }

    private static TextView text(Activity activity, String value, int size, boolean dark, float dp) {
        TextView view = new TextView(activity);
        view.setText(value); view.setTextSize(size); view.setTextColor(dark ? Color.WHITE : Color.BLACK);
        view.setPadding(0, 0, 0, Math.round(12 * dp));
        return view;
    }

    private static Button button(Activity activity, String label, Runnable action) {
        Button button = new Button(activity); button.setText(label); button.setAllCaps(false);
        button.setOnClickListener(view -> action.run()); return button;
    }
}
