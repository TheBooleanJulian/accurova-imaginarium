import type { Repository } from '../repository';
export const ApiRepository = {
  async connect(_base: string): Promise<Repository> {
    throw new Error('Server mode not built yet');
  },
};
