// The devices.connect tool for agents: the same connect request as Settings › Devices "Connect"
// (remote.connect) – by an ID or address. Eine-ID 22.11.2026: no role – the PC asked decides from the ID typed: the
// person's own ID makes this PC one of their devices (wire role 'ceo': a full mirror), a company's ID makes it a new member
// there. Both screens then show the same 4-digit code and the person on the other PC accepts there; this tool only asks.
// Its description says what a link hands over; once linked, the person gets a notice here (remote/service.ts linkedNote).
// Review 22.11.2026 (H1): an answer that would make this PC one of someone's devices stops at 'confirm' – the tool returns
// that state and never says yes itself (remote.confirm is the person's, in Settings › Devices).
// Owns: devices.connect and DeviceLink (what the device tools read of connecting PCs).
// Never: accepts on the other PC's behalf, or returns keys.

import type { RemoteService } from '../remote/service.ts';
import { json, type ToolDef } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { Meeting } from './rendezvous/service.ts';

/** Connecting PCs for devices.connect and devices.list (devices/connect.ts passes them). */
export interface DeviceLink {
  remote: Pick<RemoteService, 'ids' | 'connect'>;
  meeting: Pick<Meeting, 'state'>;
}

export function devicesConnect(link: DeviceLink): ToolDef {
  return defineTool<{ target: string }>({
    name: 'devices.connect',
    description: "Asks another PC to link with this one, by an ID or address. The ID I type decides: a company's ID makes this PC a new member of that company; a person's own ID would make it one of their devices – a full mirror of company, secrets, settings and phones, with commands on both – which the person here says yes to in Settings › Devices first. The person there accepts the same 4-digit code.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 200, description: '9-digit ID or address.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    category: 'device',
    describe: (args) => ({ summary: `Ask PC ${args.target} to link`, resource: args.target, reversible: true, external: true }),
    async run(args) {
      const out = await link.remote.connect({ target: args.target });
      const who = out.person ? `${out.person}'s` : `${out.name}'s person's`;
      return json({
        status: out.status, name: out.name, remoteId: out.remoteId, role: out.role, ...(out.company ? { company: out.company } : {}), ...(out.person ? { person: out.person } : {}),
        ...(out.code ? { code: out.code } : {}),
        next: out.status === 'confirm'
          ? `This PC would become one of ${who} devices – everything here shared with them. The person here says yes in Settings › Devices (or cancels); then ${out.name} shows a code.`
          : `${out.name} shows the code ${out.code} as well; the person there accepts in Settings › Devices. devices.list lists ${out.name} once linked.`,
      });
    },
  });
}
