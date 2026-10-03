import { AppRegistry } from 'react-native';
import { App } from './src/App';
import { name as appName } from './app.json';

// appName MUST be the interactive component id in manifest.toml. Vega's runtime
// looks the component up by that string; a display name here launches nothing.
AppRegistry.registerComponent(appName, () => App);
