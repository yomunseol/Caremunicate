export type HelpSection = {
  id: string;
  titleKey: string;
  itemKeys: string[];
};

// Localized product help content. Every visible string resolves through i18n
// (docs.*); this module only carries stable section/point keys.
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'start',
    titleKey: 'docs.start.title',
    itemKeys: ['docs.start.p1', 'docs.start.p2', 'docs.start.p3', 'docs.start.p4'],
  },
  {
    id: 'calls',
    titleKey: 'docs.calls.title',
    itemKeys: ['docs.calls.p1', 'docs.calls.p2', 'docs.calls.p3', 'docs.calls.p4'],
  },
  {
    id: 'chat',
    titleKey: 'docs.chat.title',
    itemKeys: ['docs.chat.p1', 'docs.chat.p2', 'docs.chat.p3'],
  },
  {
    id: 'feature',
    titleKey: 'docs.feature.title',
    itemKeys: ['docs.feature.p1', 'docs.feature.p2', 'docs.feature.p3', 'docs.feature.p4'],
  },
  {
    id: 'appointments',
    titleKey: 'docs.appointments.title',
    itemKeys: ['docs.appointments.p1', 'docs.appointments.p2', 'docs.appointments.p3'],
  },
  {
    id: 'care',
    titleKey: 'docs.care.title',
    itemKeys: ['docs.care.p1', 'docs.care.p2', 'docs.care.p3'],
  },
  {
    id: 'places',
    titleKey: 'docs.places.title',
    itemKeys: ['docs.places.p1', 'docs.places.p2', 'docs.places.p3'],
  },
  {
    id: 'privacy',
    titleKey: 'docs.privacy.title',
    itemKeys: ['docs.privacy.p1', 'docs.privacy.p2', 'docs.privacy.p3'],
  },
];
