import { useLang } from '../i18n';
import { DOCS_SECTIONS } from '../lib/docsContent';

// ---------------------------------------------------------------------------
// /docs — the public Caremunicate documentation page. Reached from the top bar,
// the footer, and the "View Docs" panel on the Calls hub. Chrome is translated;
// the section content is English (kept in a .ts data module).
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const { t } = useLang();

  return (
    <section className="section docs-page" aria-labelledby="docs-heading">
      <div className="section-heading">
        <div className="eyebrow">{t('common.appName')}</div>
        <h2 id="docs-heading">{t('docs.title')}</h2>
      </div>

      <div className="docs-grid">
        {DOCS_SECTIONS.map((section) => (
          <article key={section.id} className="panel docs-card">
            <h3>{section.title}</h3>
            <ul className="thin-list">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
