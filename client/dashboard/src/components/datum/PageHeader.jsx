// Presentation only: title, description, meta chips and an actions slot.
// The caller decides which actions exist and passes the existing buttons/handlers.
export default function PageHeader({ title, description, meta = [], actions = null, id }) {
  const metaItems = (Array.isArray(meta) ? meta : [meta]).filter(Boolean);
  return (
    <header className="dz-phead">
      <div style={{ minWidth: 0 }}>
        <h1 className="dz-h1" id={id}>{title}</h1>
        {description ? <p className="dz-desc">{description}</p> : null}
        {metaItems.length > 0 ? (
          <div className="dz-meta">
            {metaItems.map((item, i) => (
              <span key={i}>{item}</span>
            ))}
          </div>
        ) : null}
      </div>
      {actions ? <div className="dz-actions">{actions}</div> : null}
    </header>
  );
}
