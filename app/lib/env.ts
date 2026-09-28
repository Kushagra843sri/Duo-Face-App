const apiUrl = process.env.EXPO_PUBLIC_API_URL;

if (!apiUrl) {
  console.warn('EXPO_PUBLIC_API_URL is not set; falling back to http://localhost:4000');
}

export const env = {
  apiUrl: apiUrl ?? 'http://localhost:4000',
};
