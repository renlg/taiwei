import type { ChatMessage } from '../llm/client.js';
import type { MemoryStore } from '../memory/store.js';
import { renderSkillIndex, renderSkills } from '../skills/inject.js';
import type { Skill, SkillLoader } from '../skills/loader.js';
import type { AgentProfile } from '../agents/profiles.js';

const BASE_PERSONA = `You are taiwei, a capable proactive AI assistant running in a terminal. Be concise, practical, and transparent. Use tools when they improve accuracy. Preserve user data and ask before destructive actions.`;

export class AgentContext {
  readonly messages: ChatMessage[] = [];
  private readonly availableSkills = new Map<string, Skill>();
  private readonly activeSkills = new Map<string, Skill>();
  private readonly forcedActiveSkills = new Set<string>();
  private readonly availableUserSkills = new Map<string, Skill>();
  private readonly activeUserSkills = new Map<string, Skill>();
  private retrievedContext = '';

  constructor(readonly memory: MemoryStore, private readonly skillLoader: SkillLoader, readonly extendedMemory = true, public profile?: AgentProfile) {}

  async systemPrompt(workspace?: string, customPrompt = ''): Promise<string> {
    const sections = [BASE_PERSONA, `Current date and time: ${new Date().toString()}`];
    if (workspace) sections.push(`Current workspace (default working directory for tools): ${workspace}`);
    if (customPrompt.trim()) sections.push(`Custom instructions (from settings):\n${customPrompt.trim()}`);
    if (this.profile) sections.push(`Agent profile (${this.profile.id}, ${this.profile.mode} mode):\n${this.profile.prompt}`);
    const available = new Map([...this.availableSkills.entries()].filter(([, skill]) => !this.skillLoader.isDisabled(skill)));
    for (const [name, skill] of this.availableUserSkills) available.set(name, skill);
    const availableSkills = renderSkillIndex([...available.values()]);
    if (availableSkills) sections.push(availableSkills);
    const active = new Map([...this.activeSkills.entries()].filter(([name, skill]) => this.forcedActiveSkills.has(name) || !this.skillLoader.isDisabled(skill)));
    for (const [name, skill] of this.activeUserSkills) active.set(name, skill);
    const activeSkills = renderSkills([...active.values()]);
    if (activeSkills) sections.push(activeSkills);
    const memory = (await this.memory.tail()).trim();
    if (memory) sections.push(`Persistent memory (may be outdated; use as background only):\n${memory}`);
    if (this.retrievedContext) sections.push(this.retrievedContext);
    return sections.join('\n\n');
  }

  async loadSkill(name: string): Promise<Skill> {
    const skill = await this.skillLoader.load(name);
    this.activeSkills.set(skill.name, skill);
    return skill;
  }

  activateSkill(skill: Skill, includeDisabled = false): void {
    this.activeSkills.set(skill.name, skill);
    if (includeDisabled) this.forcedActiveSkills.add(skill.name);
    else this.forcedActiveSkills.delete(skill.name);
  }

  activateUserSkill(skill: Skill): void { this.activeUserSkills.set(skill.name, skill); }

  setAvailableSkills(skills: Skill[]): void {
    this.availableSkills.clear();
    for (const skill of skills) this.availableSkills.set(skill.name, skill);
  }

  setUserSkills(skills: Skill[]): void {
    this.availableUserSkills.clear();
    for (const skill of skills) this.availableUserSkills.set(skill.name, skill);
    for (const name of this.activeUserSkills.keys()) {
      if (!this.availableUserSkills.has(name)) this.activeUserSkills.delete(name);
    }
  }

  unloadSkill(name: string): boolean {
    this.forcedActiveSkills.delete(name);
    return this.activeSkills.delete(name) || this.activeUserSkills.delete(name);
  }

  listActiveSkills(): Skill[] { return [...this.activeSkills.values()]; }
  listActiveUserSkills(): Skill[] { return [...this.activeUserSkills.values()]; }
  setMessages(messages: ChatMessage[]): void { this.messages.splice(0, this.messages.length, ...messages); }
  setRetrievedContext(context: string): void { this.retrievedContext = context; }
  clear(): void { this.messages.length = 0; this.retrievedContext = ''; }
}
