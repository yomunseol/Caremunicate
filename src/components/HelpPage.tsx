import { useLang } from '../i18n';
import { HELP_SECTIONS } from '../lib/helpContent';

// ---------------------------------------------------------------------------
// /help — the public Caremunicate help manual. Reached from the footer only;
// the in-call "Docs" panel is the separate collaborative-documents feature.
// ---------------------------------------------------------------------------

export default function HelpPage() {
  const { t } = useLang();

  return (
    <section className="section docs-page" aria-labelledby="help-heading">
      <div className="section-heading">
        <div className="eyebrow">{t('common.appName')}</div>
        <h2 id="help-heading">{t('docs.title')}</h2>
      </div>

      <div className="docs-grid">
        {HELP_SECTIONS.map((section) => (
          <article key={section.id} className="panel docs-card">
            <h3>{t(section.titleKey)}</h3>
            <ul className="thin-list">
              {section.itemKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
