/** Any non-2xx HTTP response from the backend. */
export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** fetch() itself failed — no response was ever received. */
export class NetworkError extends Error {
  constructor() {
    super('Unable to connect. Please check your connection and try again.');
    this.name = 'NetworkError';
  }
}
