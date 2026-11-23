// Owns: the feedback notice available before Send and its readable details, including the hosting provider
// (feedback 16.11.2026: also the device facts, an attached crash report,
// the wait on the device while the PC is away and the mailbox's 30 days – the same words as openautark.com/privacy).
// 18.11.2026: a phone or browser seals and sends its report itself (direct.ts); openautark.com/privacy says the same
// (apps/website/src/pages/privacy.mjs, changed the same day). Owner 20.11.2026: a dictated report goes as its text – no
// voice recording is sent.
// Never: treats a click as consent, sends a report or opens a remote page automatically.
import { signal } from '@preact/signals';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { isMobile } from '../lib/store.ts';
import { closeFeedback } from './popover-state.ts';

const showing = signal(false);

/**
 * The note under the dock. On a phone one line in small type (feedback 16.11.2026 C2CC3D50: "in eine Zeile, Schrift
 * kleiner"): the boxes above it already say whether the screenshot goes; the details stay one tap away.
 */
export function FeedbackPrivacyNote(props: { sending: boolean }) {
  const phone = isMobile.value;
  return (
    <p class="feedback-privacy-note">
      {props.sending
        ? phone ? 'Sent encrypted to Teydra Lab, with app/device details.' : 'Text, the screenshot you keep, and app/device details are sent encrypted to Teydra Lab.'
        : phone ? 'Saved on your PC. Nothing is sent.' : 'Save keeps this report on your PC. Nothing is sent.'}{' '}
      <button type="button" class="feedback-privacy-link" onClick={() => { closeFeedback(); showing.value = true; }}>
        {phone ? 'Privacy' : 'Feedback privacy'}
      </button>
    </p>
  );
}

export function FeedbackPrivacyDialog() {
  const close = () => { showing.value = false; };
  return (
    <Dialog open={showing.value} onClose={close} title="Feedback privacy" width={640}>
      <div class="feedback-privacy-details">
        <p><a href="https://openautark.com/privacy/" target="_blank" rel="noopener noreferrer">Privacy notice on openautark.com</a></p>
        <p><strong>Who receives it.</strong> Teydra Lab, operated by Meral Anna Hees,
          Ludwig-Richter-Straße 4a/Top3, 5026 Salzburg, Austria.
          Contact: <a href="mailto:official@teydralab.com">official@teydralab.com</a>.</p>
        <p><strong>What is sent.</strong> Your feedback text, the screenshot you choose to include,
          the report ID and date, app version, operating system and the current app view, and where you wrote it:
          the kind of app and device (for example the Android app's version, Android version and phone model), screen
          size, language and the browser's user agent.
          A dictated report is sent as its written text; the voice recording of your dictation is not sent with
          it. When "Crash report attached" is on, the Android app's crash report (program
          names, device and system version) travels with it too.
          Reports filed by an agent are marked as such. When you send a report, recent warning and error messages are automatically included if available, after automatic redaction (up to 15 entries and 2,000 characters). Your chat history is not attached.
          A report sent from the PC window is also saved on your PC.</p>
        <p><strong>Why.</strong> We use reports to understand problems, fix bugs and improve the app.
          Processing is based on our legitimate interest in maintaining and improving the app
          (Article 6(1)(f) GDPR). Feedback is voluntary; you can use the app without sending it.
          Please remove personal information you do not want to share, including information about
          other people, and paint over private parts of the screenshot.</p>
        <p><strong>Transport and access.</strong> Text and the selected screenshot are encrypted for the
          team's key on the device you write on – your PC, or your phone or browser, which sends it directly (one that cannot encrypt it passes it to your PC, which does) – before
          upload to Google Cloud Firestore. While there is no connection it waits in the app's storage on that device
          and is deleted there once it is sent. The mailbox stores encrypted
          reports; the team's receiving PC decrypts them. Reports are available to the team handling
          feedback and are not published. Google also processes connection information, such as
          your IP address and request time, to provide and secure the service.</p>
        <p><strong>Hosting.</strong> Google provides Firestore as a processor under its cloud data
          processing terms. An EU database location does not exclude international processing of
          service or support data. Google's terms describe subprocessors and safeguards for
          international transfers. See <a href="https://cloud.google.com/terms/data-processing-addendum"
            target="_blank" rel="noopener noreferrer">Google's Cloud Data Processing Addendum</a>.</p>
        <p><strong>Storage.</strong> The encrypted report stays in the mailbox until the team deletes it
          there, at most 30 days. Each of the team's PCs that retrieves it keeps a copy while needed to
          handle the feedback; a report the team marked done or not relevant is deleted from its PC 7 days
          later; for the others there is no fixed automatic deletion period. Copies on your own PC follow your
          local data and backup management.</p>
        <p><strong>Your rights.</strong> You can request access, correction, deletion or restriction,
          and object to processing based on legitimate interests. Contact us with the date and
          details of your report so we can find it; we do not require a sender account.
          You can complain to your supervisory authority, including the
          <a href="https://dsb.gv.at/" target="_blank" rel="noopener noreferrer"> Austrian Data Protection Authority</a>.
          Feedback is not used for automated decisions about you.</p>
      </div>
      <DialogActions><button type="button" class="button primary" onClick={close}>Close</button></DialogActions>
    </Dialog>
  );
}
