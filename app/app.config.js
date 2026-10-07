// Dynamic layer over app.json. The Google Maps Android key is a build-time
// value read from the environment (never committed, never EXPO_PUBLIC_):
// it is written into the native manifest by the react-native-maps config
// plugin. iOS uses Apple Maps by default and needs no key.
// GOOGLE_SERVICES_JSON is the path to the Firebase google-services.json
// (needed for push on Android builds); on EAS it is a file environment variable.
module.exports = ({ config }) => {
  const androidGoogleMapsApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    plugins: [
      ...(config.plugins ?? []),
      ['react-native-maps', androidGoogleMapsApiKey ? { androidGoogleMapsApiKey } : {}],
    ],
  };
};
