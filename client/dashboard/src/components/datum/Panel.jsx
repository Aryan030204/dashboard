// Presentation only: bordered container with optional header (title/subtitle/actions) and footer.
export default function Panel({ title, subtitle, actions = null, footer = null, flush = false, ariaLabel, className = "", children, ...rest }) {
  const hasHeader = title || subtitle || actions;
  return (
    <section className={`dz-panel ${className}`.trim()} aria-label={ariaLabel || (typeof title === "string" ? title : undefined)} {...rest}>
      {hasHeader ? (
        <div className="dz-ph">
          <div style={{ minWidth: 0 }}>
            {title ? <h2 className="dz-pt">{title}</h2> : null}
            {subtitle ? <p className="dz-ps">{subtitle}</p> : null}
          </div>
          {actions ? <div className="dz-actions">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className="dz-pb">{children}</div>}
      {footer ? <div className="dz-pf">{footer}</div> : null}
    </section>
  );
}
