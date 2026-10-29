// Pure helpers for highlighting a journey in the Funnel Exploration Sankey (no React imports, so node can
// test them). Links are { source, target } node indexes, flowing from earlier steps to later ones.

function reach(start, adjacency) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.pop();
    (adjacency.get(current) || []).forEach((next) => {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    });
  }
  return seen;
}

// Which nodes and links belong to the journey through what the pointer is on. `hover` is
// { type: "node", index } or { type: "link", index }. For a node it is every path that reaches it and every
// path that continues from it; for a link it is the paths into its source, the link itself, and the paths on
// from its target. Returns null when nothing is hovered (nothing is dimmed).
export function highlightJourney(links, hover) {
  if (!hover || !Array.isArray(links)) return null;

  const forward = new Map();
  const backward = new Map();
  links.forEach((link) => {
    if (!forward.has(link.source)) forward.set(link.source, []);
    if (!backward.has(link.target)) backward.set(link.target, []);
    forward.get(link.source).push(link.target);
    backward.get(link.target).push(link.source);
  });

  let upstreamFrom;
  let downstreamFrom;
  let forcedLink = null;
  if (hover.type === "link") {
    const link = links[hover.index];
    if (!link) return null;
    upstreamFrom = link.source;
    downstreamFrom = link.target;
    forcedLink = hover.index;
  } else {
    upstreamFrom = hover.index;
    downstreamFrom = hover.index;
  }

  const upstream = reach(upstreamFrom, backward);
  const downstream = reach(downstreamFrom, forward);

  const nodes = new Set([...upstream, ...downstream]);
  const highlightedLinks = new Set();
  links.forEach((link, index) => {
    const inUpstream = upstream.has(link.source) && upstream.has(link.target);
    const inDownstream = downstream.has(link.source) && downstream.has(link.target);
    if (inUpstream || inDownstream || index === forcedLink) highlightedLinks.add(index);
  });
  return { nodes, links: highlightedLinks };
}

// Share of the sessions at the source node that continued along a link, or null with nothing to compare.
export function linkShare(link) {
  const total = Number(link?.source?.value);
  const value = Number(link?.value);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(value)) return null;
  return Math.min(100, (value / total) * 100);
}
