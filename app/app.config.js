// Dynamic layer over app.json. The Google Maps Android key is a build-time
// value read from the environment (never committed, never EXPO_PUBLIC_):
// it is written into the native manifest by the react-native-maps config
// plugin. iOS uses Apple Maps by default and needs no key.
module.exports = ({ config }) => {
  const androidGoogleMapsApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ['react-native-maps', androidGoogleMapsApiKey ? { androidGoogleMapsApiKey } : {}],
    ],
  };
};
