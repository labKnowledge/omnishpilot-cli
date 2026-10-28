/** Human-first task templates — what users pick, not how engineers run scripts */

const { LEAPTR_CAMPAIGN, LEAPTR_DELIVER, GENERIC_AGENT } = require('./connectors/ids');

const TEMPLATES = [
  {
    id: 'social-video',
    name: 'Social video + posts',
    icon: '🎬',
    description: 'Produce a short video, thumbnail, and ready-to-post copy for social media.',
    category: 'content',
    defaultRunMode: 'supervised',
    outputs: ['video.mp4', 'thumbnail.png', 'post.txt'],
    fields: [
      { key: 'dayNumber', label: 'Day number', type: 'number', placeholder: '3', help: 'Campaign day (optional)' },
      { key: 'title', label: 'Episode title', type: 'text', required: true, placeholder: 'The Silent Failure Tax' },
      { key: 'hook', label: 'Opening hook', type: 'textarea', placeholder: 'What pain does this episode open with?' },
      { key: 'cta', label: 'Call to action', type: 'text', placeholder: 'yourapp.com/signup' },
    ],
    instructionSections: [
      { key: 'voScript', label: 'Voiceover script', help: 'Leave blank for the agent to draft using lean-venture-analyst after a codebase scan' },
      { key: 'beats', label: 'Video beats', help: 'Scene list — agent fills via remotion-ads; VO must be Kokoro am_michael (not ElevenLabs)' },
      { key: 'creativeBrief', label: 'Creative direction', help: 'Visual direction; agent should scan workspace for real UI and facts' },
      { key: 'socialPost', label: 'Social post copy', help: 'Agent drafts with lean-venture-analyst — convincing, evidence-backed copy' },
      { key: 'imagePrompt', label: 'Thumbnail prompt', help: 'Brief for built-in image gen; agent pulls context from the repo' },
      { key: 'verifyNotes', label: 'Quality checklist', help: 'What must pass before we mark this done' },
    ],
    connector: LEAPTR_CAMPAIGN,
  },
  {
    id: 'agent-task',
    name: 'Custom agent job',
    icon: '🤖',
    description: 'Tell an AI agent what to do in plain language. Research, writing, code, analysis — no limits.',
    category: 'agent',
    defaultRunMode: 'supervised',
    outputs: ['result.md', 'artifacts/'],
    fields: [
      { key: 'title', label: 'Task name', type: 'text', required: true, placeholder: 'Competitive analysis for Q3' },
      { key: 'workspace', label: 'Project folder', type: 'path', placeholder: '/path/to/your/project', help: 'Folder on the server. Agent scans this for context. Leave blank for default workspace root.' },
      { key: 'goal', label: 'What should be done?', type: 'textarea', required: true, placeholder: 'Analyze our top 3 competitors and write a 1-page brief...' },
      { key: 'agentId', label: 'Agent', type: 'agent-select', help: 'Which installed agent CLI runs this job. Switch here if one has hit its usage limit.' },
    ],
    instructionSections: [
      { key: 'agentPrompt', label: 'Agent instructions', help: 'Full prompt the agent receives — edit freely' },
      { key: 'deliverables', label: 'Expected deliverables', help: 'Files or outcomes you want' },
      { key: 'constraints', label: 'Constraints', help: 'What to avoid, time limits, style rules' },
    ],
    connector: GENERIC_AGENT,
  },
  {
    id: 'deliver-content',
    name: 'Publish finished content',
    icon: '📤',
    description: 'Send completed video, images, and copy to your phone via Omnish (or social when configured).',
    category: 'publish',
    defaultRunMode: 'manual',
    outputs: [],
    fields: [
      { key: 'title', label: 'What are we sending?', type: 'text', required: true },
      { key: 'sourceDay', label: 'From campaign day', type: 'number', placeholder: '2' },
      { key: 'platforms', label: 'Where to send', type: 'select', options: ['omnish', 'omnish+manual', 'all'] },
    ],
    instructionSections: [
      { key: 'deliveryNotes', label: 'Delivery notes', help: 'Message to include with the delivery' },
    ],
    connector: LEAPTR_DELIVER,
  },
  {
    id: 'research',
    name: 'Research & report',
    icon: '🔍',
    description: 'Agent researches a topic and writes a structured report you can review.',
    category: 'agent',
    defaultRunMode: 'agent',
    outputs: ['report.md'],
    fields: [
      { key: 'title', label: 'Research topic', type: 'text', required: true },
      { key: 'questions', label: 'Key questions', type: 'textarea', placeholder: 'What do we need to learn?' },
      { key: 'sources', label: 'Sources to use', type: 'textarea', placeholder: 'URLs, docs, codebase paths...' },
      { key: 'agentId', label: 'Agent', type: 'agent-select', help: 'Which installed agent CLI runs this job. Switch here if one has hit its usage limit.' },
    ],
    instructionSections: [
      { key: 'agentPrompt', label: 'Research brief', help: 'Detailed instructions for the agent' },
      { key: 'outline', label: 'Report outline', help: 'Sections the report should include' },
    ],
    connector: GENERIC_AGENT,
  },
  {
    id: 'code-task',
    name: 'Code change',
    icon: '⚡',
    description: 'Agent makes a focused change in your codebase with verification.',
    category: 'agent',
    defaultRunMode: 'supervised',
    outputs: ['patch', 'summary.md'],
    fields: [
      { key: 'title', label: 'Change name', type: 'text', required: true },
      { key: 'workspace', label: 'Codebase path', type: 'path', required: true },
      { key: 'goal', label: 'What to build or fix', type: 'textarea', required: true },
      { key: 'agentId', label: 'Agent', type: 'agent-select', help: 'Which installed agent CLI runs this job. Switch here if one has hit its usage limit.' },
    ],
    instructionSections: [
      { key: 'agentPrompt', label: 'Implementation instructions' },
      { key: 'acceptance', label: 'Done when...', help: 'How we know it worked' },
    ],
    connector: GENERIC_AGENT,
  },
];

const RUN_MODES = [
  { id: 'auto', label: 'Fully automated', description: 'Scripts prepare assets, AI polishes, auto-verify' },
  { id: 'agent', label: 'AI agent', description: 'Agent does the work from your instructions' },
  { id: 'supervised', label: 'AI + supervisor', description: 'Agent runs, supervisor retries if quality fails' },
  { id: 'manual', label: 'Scripts only', description: 'No AI — deterministic automation only' },
];

const SCHEDULE_TYPES = [
  { id: 'manual', label: 'Run when I click Start', description: 'No automatic schedule', fields: [] },
  { id: 'now', label: 'As soon as possible', description: 'Queue immediately', fields: [] },
  { id: 'once', label: 'Once at a specific time', description: 'Run once at a chosen date and time', fields: ['runAt'] },
  { id: 'interval', label: 'Every N minutes', description: 'Repeats on an interval', fields: ['intervalMinutes'] },
  { id: 'hourly', label: 'Hourly', description: 'Repeats every hour at a chosen minute', fields: ['minute'] },
  { id: 'daily', label: 'Daily', description: 'Repeats every day at a set time', fields: ['hour', 'minute'] },
  { id: 'weekly', label: 'Specific day each week', description: 'Repeats weekly on a chosen day', fields: ['dayOfWeek', 'hour', 'minute'] },
  { id: 'monthly', label: 'Monthly', description: 'Repeats monthly on a chosen day', fields: ['dayOfMonth', 'hour', 'minute'] },
  { id: 'campaign_day', label: 'Campaign day', description: 'Tied to a numbered day in a series', fields: ['campaignDay'] },
];

function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

function buildDefaultInstructions(template, inputs = {}, learnedSkeletons = {}) {
  const instructions = {};
  for (const sec of template.instructionSections) {
    if (sec.key === 'agentPrompt' && inputs.goal) {
      instructions.agentPrompt = `# ${inputs.title || 'Task'}\n\n## Goal\n${inputs.goal}\n\n## Deliverables\n${inputs.deliverables || '(specify in editor)'}\n`;
    } else if (sec.key === 'voScript' && inputs.hook) {
      instructions.voScript = inputs.hook;
    } else if (learnedSkeletons[sec.key]?.text) {
      // Anti-unified from the user's own last few uses of this section — see skeletonMiner.js.
      instructions[sec.key] = learnedSkeletons[sec.key].text;
    } else {
      instructions[sec.key] = '';
    }
  }
  return instructions;
}

module.exports = { TEMPLATES, RUN_MODES, SCHEDULE_TYPES, getTemplate, buildDefaultInstructions };
