import * as flashpoint from 'flashpoint-launcher';
import { ContinuumApi, ContinuumPreferences } from './core/types';

export function createApi(fp: typeof flashpoint): ContinuumApi {
  return {
    getPreferences(): ContinuumPreferences {
      const prefs = fp.getPreferences();
      return {
        dataPacksFolderPath: prefs.dataPacksFolderPath,
        imageFolderPath: prefs.imageFolderPath,
        onDemandBaseUrl: prefs.onDemandBaseUrl,
        onDemandImages: prefs.onDemandImages,
        onDemandImagesCompressed: prefs.onDemandImagesCompressed,
        gameDataSources: prefs.gameDataSources || [],
        disableExtremeGames: !!prefs.disableExtremeGames,
        tagFilters: (prefs.tagFilters || []).map((group) => ({
          extreme: !!group.extreme,
          tags: group.tags || [],
        })),
      };
    },
    countGames: () => fp.games.countGames(),
    findTags: (name?: string) => fp.tags.findTags(name),
    findGamesWithTag: (tag: string) => fp.games.findGamesWithTag(tag),
    findGame: (id: string) => fp.games.findGame(id),
    saveGameData: (data) => fp.gameData.save(data),
    updateGame: (game) => fp.games.updateGame(game),
    findPlaylistByName: (name, join) => fp.games.findPlaylistByName(name, join),
  };
}
