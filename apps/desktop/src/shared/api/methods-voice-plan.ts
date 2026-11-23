// RPC contract part (STIMME 21.11.2026): the person's own phone hears a dictation itself at their ChatGPT plan. Handler:
// runtime/rpc/handlers/voice-plan.ts. Merged into Methods by module augmentation. Owns: this method shape. Never: behaviour.

declare module '../api/methods.ts' {
  interface Methods {
    /**
     * My paired Android phone's copy of the ChatGPT plan login for its own dictation (it posts a take to the plan's
     * endpoint itself): the access token, the account id, when the token expires (ms), and the language hint this PC
     * would send for `language`. `fresh`: the phone's copy was rejected – the PC has Codex refresh it first. `proof`: the
     * phone's device key's Ed25519 signature (base64url) of the lines autark-plan-login, <deviceId> and <at> (handlers/voice-plan.ts planProofText), `at` its clock in ms.
     */
    'voice.planLogin': { params: { language?: string; fresh?: true; at: number; proof: string }; result: { token: string; accountId?: string; expiresAt: number; language?: string } };
  }
}

export {};
