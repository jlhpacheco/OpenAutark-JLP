// Feedback 16.11.2026 (owner, F15: "wenn man das am Start der App, bevor man den QR-Code scannen kann oder Code eingeben
// kann … so ein Video kriegen würde, was einem zeigt, wie man da Feedback macht"): the Android app's feedback video – the
// tour's phone variant as a page of its own. scripts/tour-page.mjs bundles it with phone-page.css into one
// self-contained tour.html, which apps/android/build.ps1 puts into the APK as assets/tour.html; the app (IntroTour.java)
// shows it once before its pairing screens and again from their "How feedback works". It plays at once; Skip and
// Continue open DONE_ADDRESS, which the app takes as "done". The end card names the app's quick way in (volume up and
// volume down together, MainActivity/VolumePair.java). Owner 19.11.2026: it plays the Android tour (`bubble`) – after
// Send, the top row's round icon is pulled out and becomes the to-do bubble.
// Owns: mounting the player on this page. Never: the network, storage, the PC or its UI.

import { render } from 'preact';
import { TourPlayer } from './TourPlayer.tsx';

/** The address the app's WebView takes as "the video is done" (IntroTour.java DONE). */
export const DONE_ADDRESS = 'autark-tour:done';
/** The Android app's quick way to the feedback, said on the end card. */
export const VOLUME_NOTE = 'In the app, press volume up and down together to start feedback – hold them to talk.';

const root = typeof document === 'undefined' ? null : document.getElementById('tour');
if (root) render(<TourPlayer variant="phone" bubble autoplay skip note={VOLUME_NOTE} onDone={() => { location.href = DONE_ADDRESS; }} />, root);
