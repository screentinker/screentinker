const translations = {
  en: {
    // Nav
    'nav.displays': 'Displays',
    'nav.content': 'Content',
    'nav.layouts': 'Layouts',
    'nav.widgets': 'Widgets',
    'nav.schedule': 'Schedule',
    'nav.walls': 'Video Walls',
    'nav.reports': 'Reports',
    'nav.designer': 'Designer',
    'nav.activity': 'Activity',
    'nav.settings': 'Settings',
    'nav.subscription': 'Subscription',
    // Dashboard
    'dashboard.title': 'Displays',
    'dashboard.subtitle': 'Manage your remote displays',
    'dashboard.add': 'Add Display',
    'dashboard.search': 'Search displays...',
    'dashboard.all_status': 'All Status',
    'dashboard.online': 'Online',
    'dashboard.offline': 'Offline',
    'dashboard.no_displays': 'No displays yet',
    'dashboard.no_displays_desc': 'Install the ScreenTinker app on your TV and pair it using the button above.',
    // Content
    'content.title': 'Content Library',
    'content.subtitle': 'Upload and manage your media files',
    'content.drop': 'Drop files here or click to upload',
    'content.remote_url': 'Remote URL',
    'content.no_content': 'No content yet',
    // Common
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.loading': 'Loading...',
    'common.connected': 'Connected',
    'common.disconnected': 'Disconnected',
    // Auth
    'auth.sign_in': 'Sign In',
    'auth.create_account': 'Create Account',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.name': 'Name',
    'auth.sign_out': 'Sign out',
  },
  es: {
    'nav.displays': 'Pantallas',
    'nav.content': 'Contenido',
    'nav.layouts': 'Diseños',
    'nav.widgets': 'Widgets',
    'nav.schedule': 'Horario',
    'nav.walls': 'Video Walls',
    'nav.reports': 'Informes',
    'nav.designer': 'Diseñador',
    'nav.activity': 'Actividad',
    'nav.settings': 'Configuración',
    'nav.subscription': 'Suscripción',
    'dashboard.title': 'Pantallas',
    'dashboard.subtitle': 'Administra tus pantallas remotas',
    'dashboard.add': 'Agregar Pantalla',
    'dashboard.search': 'Buscar pantallas...',
    'dashboard.all_status': 'Todos los estados',
    'dashboard.online': 'En línea',
    'dashboard.offline': 'Desconectado',
    'dashboard.no_displays': 'Aún no hay pantallas',
    'content.title': 'Biblioteca de Contenido',
    'content.subtitle': 'Sube y administra tus archivos multimedia',
    'content.drop': 'Arrastra archivos aquí o haz clic para subir',
    'content.remote_url': 'URL Remota',
    'common.save': 'Guardar',
    'common.cancel': 'Cancelar',
    'common.delete': 'Eliminar',
    'common.edit': 'Editar',
    'common.loading': 'Cargando...',
    'common.connected': 'Conectado',
    'common.disconnected': 'Desconectado',
    'auth.sign_in': 'Iniciar Sesión',
    'auth.create_account': 'Crear Cuenta',
    'auth.email': 'Correo electrónico',
    'auth.password': 'Contraseña',
    'auth.name': 'Nombre',
    'auth.sign_out': 'Cerrar sesión',
  },
  fr: {
    'nav.displays': 'Écrans',
    'nav.content': 'Contenu',
    'nav.layouts': 'Mises en page',
    'nav.widgets': 'Widgets',
    'nav.schedule': 'Calendrier',
    'nav.walls': 'Murs vidéo',
    'nav.reports': 'Rapports',
    'nav.designer': 'Concepteur',
    'nav.activity': 'Activité',
    'nav.settings': 'Paramètres',
    'nav.subscription': 'Abonnement',
    'dashboard.title': 'Écrans',
    'dashboard.subtitle': 'Gérez vos écrans distants',
    'dashboard.add': 'Ajouter un écran',
    'dashboard.search': 'Rechercher des écrans...',
    'common.save': 'Enregistrer',
    'common.cancel': 'Annuler',
    'common.delete': 'Supprimer',
    'common.loading': 'Chargement...',
    'auth.sign_in': 'Se connecter',
    'auth.create_account': 'Créer un compte',
    'auth.sign_out': 'Se déconnecter',
  },
  de: {
    'nav.displays': 'Bildschirme',
    'nav.content': 'Inhalt',
    'nav.layouts': 'Layouts',
    'nav.widgets': 'Widgets',
    'nav.schedule': 'Zeitplan',
    'nav.walls': 'Videowände',
    'nav.reports': 'Berichte',
    'nav.designer': 'Designer',
    'nav.activity': 'Aktivität',
    'nav.settings': 'Einstellungen',
    'nav.subscription': 'Abonnement',
    'dashboard.title': 'Bildschirme',
    'dashboard.subtitle': 'Verwalten Sie Ihre Remote-Displays',
    'dashboard.add': 'Bildschirm hinzufügen',
    'dashboard.search': 'Bildschirme suchen...',
    'common.save': 'Speichern',
    'common.cancel': 'Abbrechen',
    'common.delete': 'Löschen',
    'common.loading': 'Laden...',
    'auth.sign_in': 'Anmelden',
    'auth.create_account': 'Konto erstellen',
    'auth.sign_out': 'Abmelden',
  },
};

let currentLang = localStorage.getItem('rd_lang') || navigator.language?.split('-')[0] || 'en';
if (!translations[currentLang]) currentLang = 'en';

export function t(key) {
  return translations[currentLang]?.[key] || translations.en[key] || key;
}

export function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('rd_lang', lang);
}

export function getLanguage() {
  return currentLang;
}

export function getAvailableLanguages() {
  return [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
  ];
}
