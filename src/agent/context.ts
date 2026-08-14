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
  private retrievedContext = '';

  constructor(readonly memory: MemoryStore, private readonly skillLoader: SkillLoader, readonly extendedMemory = true, public profile?: AgentProfile) {}

  async systemPrompt(workspace?: string, customPrompt = ''): Promise<string> {
    const sections = [BASE_PERSONA, `Current date and time: ${new Date().toString()}`];
    if (workspace) sections.push(`Current workspace (default working directory for tools): ${workspace}`);
    if (customPrompt.trim()) sections.push(`Custom instructions (from settings):\n${customPrompt.trim()}`);
    if (this.profile) sections.push(`Agent profile (${this.profile.id}, ${this.profile.mode} mode):\n${this.profile.prompt}`);
    const availableSkills = renderSkillIndex([...this.availableSkills.values()].filter((skill) => !this.skillLoader.isDisabled(skill)));
    if (availableSkills) sections.push(availableSkills);
    const activeSkills = renderSkills([...this.activeSkills.values()].filter((skill) => !this.skillLoader.isDisabled(skill)));
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

  activateSkill(skill: Skill): void { this.activeSkills.set(skill.name, skill); }

  setAvailableSkills(skills: Skill[]): void {
    this.availableSkills.clear();
    for (const skill of skills) this.availableSkills.set(skill.name, skill);
  }

  unloadSkill(name: string): boolean {
    return this.activeSkills.delete(name);
  }

  listActiveSkills(): Skill[] { return [...this.activeSkills.values()]; }
  setMessages(messages: ChatMessage[]): void { this.messages.splice(0, this.messages.length, ...messages); }
  setRetrievedContext(context: string): void { this.retrievedContext = context; }
  clear(): void { this.messages.length = 0; this.retrievedContext = ''; }
}
