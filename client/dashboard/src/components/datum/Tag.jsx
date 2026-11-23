// Presentation only: tone -> colors. The caller maps its own domain status to a tone.
export default function Tag({ tone = "neutral", dot = false, children, title }) {
  const cls = `dz-tag${tone && tone !== "neutral" ? ` is-${tone}` : ""}${dot ? " has-dot" : ""}`;
  return <span className={cls} title={title}>{children}</span>;
}
