// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Event } from 'vscode';
import { isTestExecution } from '../../../../common/constants';
import { traceInfo } from '../../../../logging';
import { arePathsSame, getFileInfo, pathExists } from '../../../common/externalDependencies';
import { PythonEnvInfo } from '../../info';
import { areEnvsDeepEqual, areSameEnv, getEnvPath } from '../../info/env';
import {
    BasicPythonEnvCollectionChangedEvent,
    PythonEnvCollectionChangedEvent,
    PythonEnvsWatcher,
} from '../../watcher';

export interface IEnvsCollectionCache {
    /**
     * Return all environment info currently in memory for this session.
     */
    getAllEnvs(): PythonEnvInfo[];

    /**
     * Updates environment in cache using the value provided.
     * If no new value is provided, remove the existing value from cache.
     */
    updateEnv(oldValue: PythonEnvInfo, newValue: PythonEnvInfo | undefined): void;

    /**
     * Fires with details if the cache changes.
     */
    onChanged: Event<BasicPythonEnvCollectionChangedEvent>;

    /**
     * Adds environment to cache.
     */
    addEnv(env: PythonEnvInfo, hasLatestInfo?: boolean): void;

    /**
     * Return cached environment information for a given path if it exists and
     * is up to date, otherwise return `undefined`.
     *
     * @param path - Python executable path or path to environment
     */
    getLatestInfo(path: string): Promise<PythonEnvInfo | undefined>;

    /**
     * Writes the content of the in-memory cache to persistent storage. It is assumed
     * all envs have upto date info when this is called.
     */
    flush(): Promise<void>;

    /**
     * Removes invalid envs from cache. Note this does not check for outdated info when
     * validating cache.
     * @param envs Carries list of envs for the latest refresh.
     * @param isCompleteList Carries whether the list of envs is complete or not.
     */
    validateCache(envs?: PythonEnvInfo[], isCompleteList?: boolean): Promise<void>;
}

interface IPersistentStorage {
    get(): PythonEnvInfo[];
    store(envs: PythonEnvInfo[]): Promise<void>;
}

/**
 * Environment info cache using persistent storage to save and retrieve pre-cached env info.
 */
export class PythonEnvInfoCache extends PythonEnvsWatcher<PythonEnvCollectionChangedEvent>
    implements IEnvsCollectionCache {
    private envs: PythonEnvInfo[] = [];

    /**
     * Carries the list of envs which have been validated to have latest info.
     */
    private validatedEnvs = new Set<string>();

    /**
     * Carries the list of envs which have been flushed to persistent storage.
     * It signifies that the env info is likely up-to-date.
     */
    private flushedEnvs = new Set<string>();

    constructor(private readonly persistentStorage: IPersistentStorage) {
        super();
    }

    public async validateCache(envs?: PythonEnvInfo[], isCompleteList?: boolean): Promise<void> {
        /**
         * We do check if an env has updated as we already run discovery in background
         * which means env cache will have up-to-date envs eventually. This also means
         * we avoid the cost of running lstat. So simply remove envs which are no longer
         * valid.
         */
        const areEnvsValid = await Promise.all(
            this.envs.map(async (cachedEnv) => {
                const { path } = getEnvPath(cachedEnv.executable.filename, cachedEnv.location);
                if (await pathExists(path)) {
                    if (envs && isCompleteList) {
                        /**
                         * Only consider a cached env to be valid if it's relevant. That means:
                         * * It is either reported in the latest complete refresh for this session.
                         * * Or it is relevant for some other workspace folder which is not opened currently.
                         */
                        if (cachedEnv.searchLocation) {
                            return true;
                        }
                        if (envs.some((env) => cachedEnv.id === env.id)) {
                            return true;
                        }
                    } else {
                        return true;
                    }
                }
                return false;
            }),
        );
        const invalidIndexes = areEnvsValid
            .map((isValid, index) => (isValid ? -1 : index))
            .filter((i) => i !== -1)
            .reverse(); // Reversed so indexes do not change when deleting
        invalidIndexes.forEach((index) => {
            const env = this.envs.splice(index, 1)[0];
            this.fire({ old: env, new: undefined });
        });
        if (envs) {
            // See if any env has updated after the last refresh and fire events.
            envs.forEach((env) => {
                const cachedEnv = this.envs.find((e) => e.id === env.id);
                if (cachedEnv && !areEnvsDeepEqual(cachedEnv, env)) {
                    this.updateEnv(cachedEnv, env, true);
                }
            });
        }
    }

    public getAllEnvs(): PythonEnvInfo[] {
        return this.envs;
    }

    public addEnv(env: PythonEnvInfo, hasLatestInfo?: boolean): void {
        const found = this.envs.find((e) => areSameEnv(e, env));
        if (hasLatestInfo) {
            this.validatedEnvs.add(env.id!);
            this.flush(env).ignoreErrors(); // If we have latest info, flush it so it can be saved.
        }
        if (!found) {
            this.envs.push(env);
            this.fire({ new: env });
        }
    }

    public updateEnv(oldValue: PythonEnvInfo, newValue: PythonEnvInfo | undefined, forceUpdate = false): void {
        if (this.flushedEnvs.has(oldValue.id!) && !forceUpdate) {
            // We have already flushed this env to persistent storage, so it likely has upto date info.
            // If we have latest info, then we do not need to update the cache.
            return;
        }
        const index = this.envs.findIndex((e) => areSameEnv(e, oldValue));
        if (index !== -1) {
            if (newValue === undefined) {
                this.envs.splice(index, 1);
            } else {
                this.envs[index] = newValue;
            }
            this.fire({ old: oldValue, new: newValue });
        }
    }

    public async getLatestInfo(path: string): Promise<PythonEnvInfo | undefined> {
        // `path` can either be path to environment or executable path
        const env = this.envs.find((e) => arePathsSame(e.location, path)) ?? this.envs.find((e) => areSameEnv(e, path));
        if (env) {
            if (this.validatedEnvs.has(env.id!)) {
                return env;
            }
            if (await validateInfo(env)) {
                this.validatedEnvs.add(env.id!);
                return env;
            }
        }
        return undefined;
    }

    public clearAndReloadFromStorage(): void {
        this.envs = this.persistentStorage.get();
        this.markAllEnvsAsFlushed();
    }

    public async flush(env?: PythonEnvInfo): Promise<void> {
        if (env) {
            // Flush only the given env.
            const envs = this.persistentStorage.get();
            const index = envs.findIndex((e) => e.id === env.id);
            envs[index] = env;
            this.flushedEnvs.add(env.id!);
            await this.persistentStorage.store(envs);
            return;
        }
        traceInfo('Environments added to cache', JSON.stringify(this.envs));
        this.markAllEnvsAsFlushed();
        await this.persistentStorage.store(this.envs);
    }

    private markAllEnvsAsFlushed(): void {
        this.envs.forEach((e) => {
            this.flushedEnvs.add(e.id!);
        });
    }
}

async function validateInfo(env: PythonEnvInfo) {
    const { ctime, mtime } = await getFileInfo(env.executable.filename);
    if (ctime === env.executable.ctime && mtime === env.executable.mtime) {
        return true;
    }
    env.executable.ctime = ctime;
    env.executable.mtime = mtime;
    return false;
}

/**
 * Build a cache of PythonEnvInfo that is ready to use.
 */
export async function createCollectionCache(storage: IPersistentStorage): Promise<PythonEnvInfoCache> {
    const cache = new PythonEnvInfoCache(storage);
    cache.clearAndReloadFromStorage();
    await validateCache(cache);
    return cache;
}

async function validateCache(cache: PythonEnvInfoCache) {
    if (isTestExecution()) {
        // For purposes for test execution, block on validation so that we can determinally know when it finishes.
        return cache.validateCache();
    }
    // Validate in background so it doesn't block on returning the API object.
    return cache.validateCache().ignoreErrors();
}
