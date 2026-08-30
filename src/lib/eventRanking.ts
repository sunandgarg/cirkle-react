type RankableEvent = {
  id: string;
  start_time: string;
  source_iit?: string | null;
  target_iits?: string[] | null;
};

const normalize = (value?: string | null) => value?.trim().toLocaleLowerCase("en-IN") || "";

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const groupForEvent = (event: RankableEvent, viewerIit: string) => {
  const sourceIit = event.source_iit?.trim();
  if (sourceIit) return normalize(sourceIit) === normalize(viewerIit) ? "__own__" : `iit:${normalize(sourceIit)}`;

  const targets = [...new Set((event.target_iits || []).map((iit) => iit.trim()).filter(Boolean))].sort();
  if (viewerIit && targets.some((iit) => normalize(iit) === normalize(viewerIit))) return "__own__";
  return targets.length ? `iit:${targets.map(normalize).join("|")}` : "__all__";
};

/**
 * Keeps the viewer's institute first, universal events second, and every other
 * institute in one stable adjacent block. The block order changes by seed, not
 * during a render, so the feed feels fresh without jumping around.
 */
export const rankEventsForViewer = <T extends RankableEvent>(events: T[], viewerIit?: string | null, seed = "events") => {
  const groups = new Map<string, T[]>();
  for (const event of events) {
    const key = groupForEvent(event, viewerIit || "");
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort((left, right) => new Date(left.start_time).getTime() - new Date(right.start_time).getTime() || left.id.localeCompare(right.id));
  }

  const priority = (key: string) => key === "__own__" ? 0 : key === "__all__" ? 1 : 2;
  return [...groups.keys()]
    .sort((left, right) => priority(left) - priority(right)
      || stableHash(`${seed}:${left}`) - stableHash(`${seed}:${right}`)
      || left.localeCompare(right))
    .flatMap((key) => groups.get(key) || []);
};

export const isEventFromInstitute = (event: RankableEvent, institute?: string | null) => {
  if (!institute) return false;
  if (event.source_iit) return normalize(event.source_iit) === normalize(institute);
  return (event.target_iits || []).some((iit) => normalize(iit) === normalize(institute));
};
