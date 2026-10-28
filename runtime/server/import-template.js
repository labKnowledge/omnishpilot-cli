const templates = require('./templates');

const RECOMMENDED_SKILLS = [
  {
    id: 'lean-venture-analyst',
    when: 'Marketing copy, hooks, positioning, social posts, voiceover scripts, thumbnail briefs',
    note: 'Stress-test claims and write convincing, evidence-backed copy — not generic AI fluff.',
  },
  {
    id: 'remotion-ads',
    when: 'Remotion video ads / social reels / explainers',
    note: 'Require Kokoro voice am_michael for all VO (not ElevenLabs).',
  },
  {
    id: 'google-workspace-ad-skill',
    when: 'Polished 15s social ad squares',
  },
  {
    id: 'frontend-design',
    when: 'Built-in image generation briefs and visual direction',
  },
  {
    id: 'content-strategy',
    when: 'Series planning and editorial calendars',
  },
  {
    id: 'coding-agent',
    when: 'Implementation tasks in a repo',
  },
];

function buildImportTemplate(cfg = {}) {
  const ws = cfg.workspaces?.[0];
  const timezone = cfg.scheduler?.defaultTimezone || ws?.meta?.timezone || 'America/Denver';

  return {
    _guide: {
      title: 'OmnishPilot job import',
      version: '2.0',
      philosophy: 'Keep imports short. Point the agent at skills and a workspace — let it scan the codebase, draft scripts, and produce assets. You review in the UI before anything runs.',
      required: ['templateId', 'title'],
      optional: ['inputs', 'instructions', 'schedule', 'runMode', 'workspaceId', 'summary', 'skills'],
      skills: RECOMMENDED_SKILLS,
      agentWorkflow: [
        'Set inputs.workspace to a real folder path on the server.',
        'List skills in instructions.agentPrompt (or a dedicated skills array on the job).',
        'Tell the agent to scan the codebase for context before writing copy or code.',
        'For video/social jobs: use lean-venture-analyst for script + post copy; use remotion-ads for rendering with Kokoro am_michael voiceover (not ElevenLabs).',
        'Leave instruction sections empty when the agent should generate them from inputs + skills.',
      ],
      scheduleTypes: ['manual', 'now', 'once', 'interval', 'hourly', 'daily', 'weekly', 'monthly'],
      templateIds: templates.TEMPLATES.map(t => t.id),
      docs: 'Full template reference: GET /api/meta — or use the in-app job wizard.',
    },
    jobs: [
      {
        _example: 'Agent job — lean copy + codebase scan (manual start)',
        templateId: 'agent-task',
        title: 'Draft launch post from repo context',
        summary: 'Research + copy',
        runMode: 'supervised',
        schedule: { type: 'manual' },
        skills: ['lean-venture-analyst', 'content-strategy'],
        inputs: {
          title: 'Draft launch post from repo context',
          workspace: '/path/to/your/project',
          goal: 'Scan the codebase and README. Write a convincing launch post and 3 hook variants for social.',
        },
        instructions: {
          agentPrompt: 'Use skills: lean-venture-analyst, content-strategy.\n\n1. Scan the workspace (README, package.json, key docs) for facts.\n2. Apply lean-venture-analyst for positioning and hooks.\n3. Output result.md with post copy + hooks — no invented metrics.',
          deliverables: 'result.md',
          constraints: 'Public facts only. Cite file paths you used.',
        },
      },
      {
        _example: 'Remotion video — agent writes script; pipeline renders',
        templateId: 'social-video',
        title: 'Product explainer — 45s',
        runMode: 'supervised',
        schedule: { type: 'manual' },
        skills: ['lean-venture-analyst', 'remotion-ads'],
        inputs: {
          title: 'Product explainer — 45s',
          hook: 'Open on the pain point the product solves',
          cta: 'yourapp.com',
        },
        instructions: {
          voScript: '',
          beats: '',
          creativeBrief: 'Scan workspace for UI screenshots and architecture. Agent fills beats + Remotion direction via remotion-ads.',
          socialPost: '',
          imagePrompt: '',
          verifyNotes: 'Script cites real product facts. VO is Kokoro am_michael only — never ElevenLabs.',
        },
      },
      {
        _example: 'Daily recurring digest',
        templateId: 'agent-task',
        title: 'Morning repo digest',
        runMode: 'agent',
        schedule: { type: 'daily', hour: 8, minute: 30, timezone },
        skills: ['coding-agent'],
        inputs: {
          title: 'Morning repo digest',
          workspace: '/path/to/your/project',
          goal: 'Summarize overnight commits, open PRs, and failing CI. Flag blockers.',
        },
      },
      {
        _example: 'One-shot research',
        templateId: 'research',
        title: 'Competitive landscape scan',
        schedule: { type: 'now' },
        runMode: 'agent',
        skills: ['lean-venture-analyst'],
        inputs: {
          title: 'Competitive landscape scan',
          questions: 'Who are the top 5 alternatives? How do they position?',
          sources: 'Public web, product sites, G2',
        },
        instructions: {
          agentPrompt: 'Use lean-venture-analyst for sharp, honest positioning analysis. No fluff.',
        },
      },
      {
        _example: 'Code change with verification',
        templateId: 'code-task',
        title: 'Add health check endpoint',
        runMode: 'supervised',
        schedule: { type: 'manual' },
        skills: ['coding-agent'],
        inputs: {
          title: 'Add health check endpoint',
          workspace: '/path/to/your/project',
          goal: 'Add GET /api/health returning { ok: true, version }. Match existing patterns.',
        },
        instructions: {
          acceptance: 'Endpoint returns 200. Tests pass.',
        },
      },
      {
        _example: 'Weekly report',
        templateId: 'research',
        title: 'Weekly metrics summary',
        runMode: 'agent',
        schedule: {
          type: 'weekly',
          dayOfWeek: 5,
          hour: 16,
          minute: 0,
          timezone,
        },
        inputs: {
          title: 'Weekly metrics summary',
          questions: 'What changed week over week? Any anomalies?',
        },
      },
    ],
  };
}

function buildCampaignPlanTemplate() {
  return {
    _guide: {
      title: 'OmnishPilot campaign plan (days.json)',
      version: '1.0',
      philosophy: 'One entry per campaign day. This replaces the whole plan for a workspace — every day you want on the board must be listed.',
      required: ['day', 'title'],
      optional: ['pillar', 'duration_target', 'vo_script', 'social_post', 'image_prompt', 'cta', 'beats', 'creative'],
      fieldNotes: {
        day: 'Positive integer, unique across the plan. Determines schedule (campaign day N).',
        title: 'Short episode title shown on the board and in the video.',
        pillar: 'Content pillar / theme label, e.g. "Pain", "Proof", "CTA".',
        duration_target: 'Free text, e.g. "44s · 4 beats" — a target for the render, not enforced.',
        vo_script: 'Full voiceover script. Leave blank for the agent to draft.',
        social_post: 'Ready-to-post social copy. Leave blank for the agent to draft.',
        image_prompt: 'Thumbnail image brief. Leave blank for the agent to draft.',
        cta: 'Call to action shown at the end, e.g. "yourapp.com/signup".',
        beats: 'Array of { caption, icon, animation } scene beats — the on-screen scene list.',
        creative: 'Optional freeform object with any extra creative direction (visual_lens, palette, hero_icons, etc.) — passed through as-is.',
      },
      docs: 'Import with "Full campaign plan" in the Import jobs modal, or edit day-by-day in the Compose tab.',
    },
    days: [
      {
        day: 1,
        title: 'The Problem Nobody Names',
        pillar: 'Pain',
        duration_target: '44s · 4 beats',
        vo_script: 'Everyone ships the happy path.\nNobody tests what breaks it.\n\nThat gap is where churn lives.\n\nOur tool finds it before your users do.\nFree to try. yourapp.com/audit',
        beats: [
          { caption: 'HAPPY PATH ONLY', icon: 'laptop', animation: '' },
          { caption: 'EDGE CASE HITS', icon: 'spinner', animation: '' },
          { caption: 'USER LEAVES', icon: 'phone', animation: '' },
          { caption: 'WE CATCH IT FIRST', icon: 'magnifying-glass', animation: '' },
        ],
        cta: 'yourapp.com/audit',
        social_post: 'Your happy path works great.\nIt is the other 20% that churns users.\n\nFree audit: yourapp.com/audit',
        image_prompt: '9:16 split screen, smooth app on left, cracked/error app on right, dark background, cinematic',
        creative: { palette: 'amber', hero_icons: ['laptop', 'spinner', 'phone'] },
      },
      {
        day: 2,
        title: 'Week 1 Recap',
        pillar: 'Proof',
        duration_target: '30s · 3 beats',
        vo_script: '',
        beats: [],
        cta: 'yourapp.com/audit',
        social_post: '',
        image_prompt: '',
      },
    ],
  };
}

function stripGuideForImport(body) {
  if (Array.isArray(body)) return body;
  if (body?.jobs && Array.isArray(body.jobs)) {
    return body.jobs.map(stripExampleComments);
  }
  return null;
}

function stripExampleComments(job) {
  if (!job || typeof job !== 'object') return job;
  const { _example, ...rest } = job;
  return rest;
}

module.exports = { buildImportTemplate, buildCampaignPlanTemplate, stripGuideForImport, stripExampleComments, RECOMMENDED_SKILLS };
