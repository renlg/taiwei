import type { TaiweiApp } from '../app.js';
import { AgentContext } from '../agent/context.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ChatMessage, ContentBlock } from '../llm/client.js';
import type { ConfirmationDecision, ConfirmationRequest } from '../security/commands.js';
import { renderRetrievedContext } from '../rag/prompt.js';
import { retrieve } from '../rag/retrieve.js';
import { MemoryStore } from '../memory/store.js';
import type { TenantIdentity } from '../tools/registry.js';
import type { Skill } from '../skills/loader.js';

export interface ChatSink {
  event(event: AgentEvent): void;
  error(error: Error): void;
  context?(messages: ChatMessage[]): void;
  confirm?(request: ConfirmationRequest): Promise<ConfirmationDecision>;
}

export interface ChatBridge {
  run(message: string, sink: ChatSink, history?: ChatMessage[], sessionId?: string, memory?: MemoryStore, agentId?: string, role?: 'admin' | 'guest', identity?: string, runtimeSessionId?: string, providerId?: string, model?: string, workspaceRoot?: string, userContent?: ContentBlock[], tenantIdentity?: TenantIdentity, guestId?: string): Promise<void>;
  stop(sessionId?: string): boolean;
}

export class AgentChatBridge implements ChatBridge {
  private readonly activeGuestUserSkills = new Map<string, Set<string>>();

  constructor(private readonly app: TaiweiApp) {}

  async run(message: string, sink: ChatSink, history: ChatMessage[] = [], sessionId?: string, memory?: MemoryStore, agentId = 'build', role: 'admin' | 'guest' = 'admin', identity?: string, runtimeSessionId?: string, providerId?: string, model?: string, workspaceRoot?: string, userContent?: ContentBlock[], tenantIdentity?: TenantIdentity, guestId?: string): Promise<void> {
    const context = new AgentContext(memory ?? this.app.memory, this.app.skills, !memory);
    context.setMessages(history);
    for (const skill of this.app.context.listActiveSkills()) context.activateSkill(skill);
    const owner = role === 'guest' ? guestId ?? 'guest' : 'admin';
    const guestActivationKey = role === 'guest' ? runtimeSessionId ?? `${owner}:${sessionId ?? 'local'}` : undefined;
    if (role === 'admin') for (const skill of this.app.context.listActiveUserSkills()) context.activateUserSkill(skill);
    if (this.app.config.autoLoadSkills !== false) {
      try {
        context.setAvailableSkills(await this.app.skills.list());
        const userSkills: Skill[] = await this.app.userSkills.loadEnabled(owner, await this.app.userSkillStates.disabled(owner));
        context.setUserSkills(userSkills);
        const activeGuestSkills = guestActivationKey ? this.activeGuestUserSkills.get(guestActivationKey) : undefined;
        if (activeGuestSkills) for (const skill of userSkills) if (activeGuestSkills.has(skill.name)) context.activateUserSkill(skill);
      } catch { /* Missing or unreadable skills must never block a web chat turn. */ }
    }
    try {
      try { context.setRetrievedContext(renderRetrievedContext(await retrieve(message))); }
      catch { /* RAG is optional and must never block a web chat turn. */ }
      await this.app.run(message, {
        context,
        enableDiagnostics: true,
        onEvent: (event) => sink.event(event),
        confirmDanger: sink.confirm,
        sessionId,
        skipBeforeMessageHook: true,
        agentId,
        role, identity: identity ?? role, guestId, tenantIdentity, runtimeSessionId, providerId, model, workspaceRoot,
        userContent,
      });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      sink.error(reason.name === 'AbortError' ? new Error('Turn cancelled') : reason);
    } finally {
      if (guestActivationKey) this.activeGuestUserSkills.set(guestActivationKey, new Set(context.listActiveUserSkills().map((skill) => skill.name)));
      sink.context?.(structuredClone(context.messages));
    }
  }

  stop(sessionId = 'local'): boolean { return this.app.stopSession?.(sessionId) ?? this.app.interrupt.cancel(); }
}
