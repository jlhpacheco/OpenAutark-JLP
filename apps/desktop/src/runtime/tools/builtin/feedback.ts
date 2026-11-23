// feedback.report (owner 21.11.2026: the AI operates the feedback system itself): an agent sends a report about the app
// to Autark's maker right away – its text and kind, the current screen of this PC and further images, each with the
// agent's covering blocks painted solid black before anything leaves the PC (feedback-images.ts). The report goes
// through FeedbackService.create (pattern redaction, author = the agent so it stays marked as an agent's, the run id,
// the same text within 24 h only raises a count, at most 5 new reports per agent per day – then a short refusal) and
// send; the answer is the report number (feedback-delivery.ts reportNumber), or where it waits to go by itself.
// Trust AI mode only (owner: "Nicht im Secure-Modus"): feedbackOpen decides; the registry offers the tool nowhere else
// (tools/registry.ts allowed), and a call that still arrives – another company of this PC forwarding it – is refused.
// Review 21.11.2026: blocks are fractions 0..1 of their image (the size an agent sees an image at differs by engine); the
// screen is taken fresh when the report goes, so its blocks are fractions of the screen as it is then. The category is
// `communicate` – the person's "messages" switch gates it, as it gates the RPC path (security/rpc-map.ts feedback).
// Owns: the agent-facing tool and its texts (feedbackOpen: feedback/service.ts). Never: sends an image whose blocks were not painted, or
// pushes a notification to the person.

import type { ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { FeedbackKind, FeedbackReport } from '../../../shared/model/system.ts';
import { FEEDBACK_IMAGES_MAX, reportNumber } from '../../../shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { FeedbackService, feedbackOpen, passing } from '../../feedback/service.ts';
import { IMAGE_COVER_MAX } from '../../../shared/api/host-bridge.ts';
import { reclaimerOf } from '../../files/cleanup.ts';
import { clip, defineTool } from './util.ts';
import { askedImages, blockRefusal, prepareImages, SCREEN, type ImageAsk } from './feedback-images.ts';

export const FEEDBACK_TOOL = 'feedback.report';
const KINDS: FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];

type Args = ImageAsk & { kind: FeedbackKind; text: string };

/** What the tool reaches the feedback system through (tests pass one with their own mailbox). */
export type FeedbackFor = (services: RuntimeServices) => Pick<FeedbackService, 'create' | 'send'>;

const FRACTION = { type: 'number', minimum: 0, maximum: 1 };
const SIZE = { type: 'number', exclusiveMinimum: 0, maximum: 1 };
const COVER_BLOCK = {
  type: 'object',
  properties: {
    image: { type: 'string', minLength: 1, maxLength: 1024, description: `"${SCREEN}", or a fileId or path exactly as I pass it.` },
    x: FRACTION, y: FRACTION, width: SIZE, height: SIZE,
  },
  required: ['image', 'x', 'y', 'width', 'height'], additionalProperties: false,
};

/** feedback.report over `feedbackFor` (default: a FeedbackService of the runtime, which reads the shipped receiver). */
export function feedbackReport(feedbackFor: FeedbackFor = (services) => new FeedbackService({ services: () => services })): ToolDef {
  return defineTool<Args>({
    name: FEEDBACK_TOOL,
    description: 'Sends Autark\'s maker a report about the app – a bug, a missing ability, an idea, what works well – with the screen and images. '
      + 'It reaches the developer with everything in it, personal data included: whatever private shows in an image I cover with blocks, painted black before anything leaves this PC. Up to 5 a day, each problem once.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        text: { type: 'string', minLength: 5, maxLength: 8000 },
        screen: { type: 'boolean', description: 'The screen of this PC as it is when I send – I send right after looking at it.' },
        fileIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1000 }, maxItems: FEEDBACK_IMAGES_MAX, description: 'Stored images.' },
        paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1024 }, maxItems: FEEDBACK_IMAGES_MAX, description: 'Image files on this PC.' },
        cover: { type: 'array', items: COVER_BLOCK, maxItems: IMAGE_COVER_MAX, description: 'Blocks painted solid black, as fractions 0..1 of that image\'s width and height (x, y the top left corner).' },
      },
      required: ['kind', 'text'], additionalProperties: false,
    },
    category: 'communicate', // it leaves the company: the "messages" switch decides, as for the RPC path
    describe: (args) => ({ summary: `Feedback to Autark's maker (${args.kind}): ${clip(args.text, 60)}`, resource: 'Autark\'s maker', reversible: false, external: true }),
    async run(args, ctx) {
      if (!feedbackOpen(ctx.services)) return failure('This company runs in Secure mode, so nothing goes to Autark\'s maker from here.');
      const count = askedImages(args).length;
      if (count > FEEDBACK_IMAGES_MAX) return failure(`A report carries at most ${FEEDBACK_IMAGES_MAX} images; I send ${count}.`);
      const refused = blockRefusal(args);
      if (refused) return failure(refused);
      const feedback = feedbackFor(ctx.services);
      if (count) ctx.status('preparing the images');
      const images = count ? await prepareImages(ctx, args) : { ids: [], dropped: [] };
      const unused = () => { if (images.ids.length) reclaimerOf(ctx.services.files)?.reclaim(images.ids); };
      let report: FeedbackReport;
      try {
        report = feedback.create({ kind: args.kind, text: args.text, imageFileIds: images.ids, conversationId: ctx.conversationId, runId: ctx.runId, author: ctx.agent.id });
      } catch (error) {
        unused();
        if (error instanceof WorkforceError && error.code === 'conflict') return failure(error.message);
        throw error;
      }
      const repeat = Boolean(report.count && report.count > 1);
      if (repeat) unused(); // the earlier report keeps its own images
      ctx.status('sending the report');
      try {
        report = await feedback.send(report.id);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return json({
          ok: false, id: report.id,
          note: passing(error) ? `Saved on this PC; it goes out by itself once the connection is back (${why})` : `Saved on this PC, not sent: ${why}`,
          ...(images.dropped.length ? { notSent: images.dropped } : {}),
        });
      }
      return json({
        ok: true, number: reportNumber(report.receiptId), images: repeat ? undefined : images.ids.length,
        ...(repeat ? { note: 'Already reported in the last 24 hours; counted again – the earlier report with its images stands.' } : {}),
        ...(images.dropped.length ? { notSent: images.dropped } : {}),
      });
    },
  });
}

export const feedbackTools: ToolDef[] = [feedbackReport()];
