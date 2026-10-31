export type DocsSection = {
  id: string;
  title: string;
  items: string[];
};

// Product documentation content. Kept in a .ts module (not scanned by the JSX
// i18n guard) so the docs page can render variables instead of literal JSX text.
export const DOCS_SECTIONS: DocsSection[] = [
  {
    id: 'start',
    title: 'Getting started',
    items: [
      'Create an account with your email and a strong password.',
      'Verify your email with the 6-digit code we send you.',
      'Choose your role: patient, doctor, department, or hospital.',
      'Your dashboard opens after verification. Use the top bar to reach Calls, Calendar, Hospitals, and Doctors.',
    ],
  },
  {
    id: 'calls',
    title: 'Calls',
    items: [
      'Open Calls from the top bar to see your personal line and the join box.',
      'Share your personal code, or enter someone else’s code to join their room.',
      'Calls support video, audio, screen sharing, reactions, and a raise-hand.',
      'Calls are not recorded.',
    ],
  },
  {
    id: 'chat',
    title: 'In-call chat',
    items: [
      'Open the chat bubble in the call control bar.',
      'Type a message and press Enter, or use the send button.',
      'Messages are stored for the call, so joining late or refreshing loads the history.',
    ],
  },
  {
    id: 'docs',
    title: 'Caremunicate Docs',
    items: [
      'Doctors can open Docs from the call control bar or the overflow menu.',
      'Create a new doc and choose Locked or Unlocked.',
      'Locked docs become read-only when the call ends; unlocked docs stay editable.',
      'Docs autosave as you type.',
    ],
  },
  {
    id: 'appointments',
    title: 'Appointments and calendar',
    items: [
      'Use Calendar to see upcoming appointments and availability.',
      'Doctors can publish weekly availability and confirm bookings.',
      'Patients can book an open slot and join the call from the appointment.',
    ],
  },
  {
    id: 'care',
    title: 'Care plans',
    items: [
      'Providers can create care plans with daily or weekly tasks.',
      'Patients mark tasks complete and track progress over time.',
      'Care plans live alongside appointments and conversations in each patient profile.',
    ],
  },
  {
    id: 'places',
    title: 'Hospitals and places',
    items: [
      'Search for hospitals, clinics, and pharmacies by name or use Near me.',
      'Save places to your favourites for quick access.',
      'Map results fall back to cached data when the live map service is unavailable.',
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy and security',
    items: [
      'Accounts require a verified email and a strong password.',
      'Data access is enforced at the database level with row-level security.',
      'Calls are peer-to-peer; recording has been removed from the product.',
    ],
  },
];
