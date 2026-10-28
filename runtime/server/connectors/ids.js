// Canonical connector identifiers. Every other module (templates, the registry, the few
// endpoints that create or scaffold a specific connector type) references these instead of
// retyping the string, so adding or renaming a connector never needs a codebase-wide find/replace.
module.exports = {
  LEAPTR_CAMPAIGN: 'leaptr-campaign',
  LEAPTR_DELIVER: 'leaptr-deliver',
  GENERIC_AGENT: 'generic-agent',
  SHELL_COMMAND: 'shell-command',
};
