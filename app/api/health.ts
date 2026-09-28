import { apiRequest } from '@/api/client';

interface HealthResponse {
  status: string;
}

export function getHealth() {
  return apiRequest<HealthResponse>('/health');
}
