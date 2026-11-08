import type { NearbyStop, NearbyStopsQuery } from "./domain/types";
import type { StopService } from "./interfaces/inbound/stop-service";
import type { StopRepository } from "./interfaces/outbound/stop-repository";

export class StopServiceImpl implements StopService {
  constructor(private readonly stopRepository: StopRepository) {
    this.stopRepository = stopRepository;
  }

  getNearbyStops(query: NearbyStopsQuery): Promise<NearbyStop[]> {
    return this.stopRepository.findStopsNear(query);
  }
}
