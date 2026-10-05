// Shared guard for automation plugins (retrieval, knowledge, telegram,
// profile, idea, brain-first).
//
// Any automation plugin that spawns a child session to run a sub-agent
// (e.g. the knowledge-hook's rag-brain consolidation drain) must register the
// child session ID here BEFORE sending it a message. The other plugins
// consult this set to skip those child sessions, so sub-agent work is never
// re-processed or re-delivered.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
export const automationChildSessions = new Set<string>()
