// Owns: where the to-do button sits (TodoButton) as plain numbers in screen pixels – a drag beyond the touch slop moves
// it, a drop with the finger at a side edge turns it into the slim tab on that side, the dot and the panel stay whole on
// the screen, the panel keeps above the keyboard while the person types, the hide target (✕ at the bottom centre while
// the dot is dragged) and whether the finger is over it, and a screenshot's size (longest side at most SHOT_MAX). Pure,
// so a host test pins it. Never: Android classes.
package com.teydralab.autark.android.phoneuse;

final class TodoPlace {
    /** A screenshot's longest side at most (JPEG ~85, as the page's own feedback shot). */
    static final int SHOT_MAX = 1600;
    /** The keyboard may take the screen below this share of its height. */
    static final float ABOVE_KEYBOARD = 0.42f;

    private TodoPlace() {}

    /** A finger that moved more than `slop` from where it came down drags; less is a tap. */
    static boolean dragged(float dx, float dy, float slop) { return dx * dx + dy * dy > slop * slop; }

    /** The value moved into 0 … room − size (0 when it does not fit at all). */
    static int clamp(int value, int size, int room) { return Math.max(0, Math.min(value, room - size)); }

    /** The finger let go within `edge` px of the left or right side: the dot becomes the tab there. */
    static boolean droppedAtEdge(float fingerX, int screenWidth, int edge) { return fingerX <= edge || fingerX >= screenWidth - edge; }

    /** The tab's side: the side the dot's middle is nearer to. */
    static boolean left(int x, int width, int screenWidth) { return x + width / 2 < screenWidth / 2; }

    /** The x of a box of `width` glued to the side. */
    static int sideX(boolean left, int width, int screenWidth) { return left ? 0 : Math.max(0, screenWidth - width); }

    /**
     * The panel's corner next to the dot: beside it on the side with more room (its top at the dot's top), whole on the
     * screen. Returns {x, y}.
     */
    static int[] panel(int dotX, int dotY, int dotSize, int width, int height, int screenWidth, int screenHeight) {
        boolean right = dotX + dotSize / 2 < screenWidth / 2;
        int x = right ? dotX : dotX + dotSize - width;
        return new int[] { clamp(x, width, screenWidth), clamp(dotY, height, screenHeight) };
    }

    /** While the person types: the panel's y with its bottom above the keyboard's likely top (unchanged when it already is). */
    static int aboveKeyboard(int y, int height, int screenHeight) {
        int bottom = Math.round(screenHeight * ABOVE_KEYBOARD);
        return y + height <= bottom ? y : Math.max(0, bottom - height);
    }

    /** The hide target's corner: `size` square, centred, `gap` above the bottom edge. Returns {x, y}. */
    static int[] binCorner(int screenWidth, int screenHeight, int size, int gap) {
        return new int[] { Math.max(0, (screenWidth - size) / 2), Math.max(0, screenHeight - size - gap) };
    }

    /** The finger within `radius` of (x, y). */
    static boolean near(float fingerX, float fingerY, float x, float y, float radius) {
        float dx = fingerX - x, dy = fingerY - y;
        return dx * dx + dy * dy <= radius * radius;
    }

    /** A screenshot of width × height scaled so its longest side is at most SHOT_MAX: {width, height}. */
    static int[] shotSize(int width, int height) {
        int longest = Math.max(width, height);
        if (longest <= SHOT_MAX || longest <= 0) return new int[] { width, height };
        float scale = SHOT_MAX / (float) longest;
        return new int[] { Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)) };
    }
}
