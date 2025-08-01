import { createPatch } from "diff";
import type {
    AuthCallback,
    AuthFailureCallback,
    GitHttpRequest,
    GitHttpResponse,
    GitProgressEvent,
    HttpClient,
    Walker,
    WalkerMap,
} from "isomorphic-git";
import git, { Errors, readBlob } from "isomorphic-git";
import { Notice, requestUrl } from "obsidian";
import type ObsidianGit from "../main";
import type {
    BranchInfo,
    FileStatusResult,
    LogEntry,
    Status,
    UnstagedFile,
    WalkDifference,
} from "../types";
import { CurrentGitAction, type DiffFile } from "../types";
import { GeneralModal } from "../ui/modals/generalModal";
import { splitRemoteBranch, worthWalking } from "../utils";
import { GitManager } from "./gitManager";
import { MyAdapter } from "./myAdapter";

export class IsomorphicGit extends GitManager {
    private readonly FILE = 0;
    private readonly HEAD = 1;
    private readonly WORKDIR = 2;
    private readonly STAGE = 3;
    // Mapping from statusMatrix to git status codes based off git status --short
    // See: https://isomorphic-git.org/docs/en/statusMatrix
    private readonly status_mapping = {
        "000": "  ",
        "003": "AD",
        "020": "??",
        "022": "A ",
        "023": "AM",
        "100": "D ",
        "101": " D",
        "103": "MD",
        "110": "DA", // Technically, two files: first one is deleted "D " and second one is untracked "??"
        "111": "  ",
        "113": "MM",
        "120": "DA", // Same as "110"
        "121": " M",
        "122": "M ",
        "123": "MM",
    };
    private readonly noticeLength = 999_999;
    private readonly fs = new MyAdapter(this.app.vault, this.plugin);

    constructor(plugin: ObsidianGit) {
        super(plugin);
    }

    getRepo(): {
        fs: MyAdapter;
        dir: string;
        gitdir?: string;
        onAuth: AuthCallback;
        onAuthFailure: AuthFailureCallback;
        http: HttpClient;
    } {
        return {
            fs: this.fs,
            dir: this.plugin.settings.basePath,
            gitdir: this.plugin.settings.gitDir || undefined,
            onAuth: () => {
                return {
                    username:
                        this.plugin.localStorage.getUsername() ?? undefined,
                    password:
                        this.plugin.localStorage.getPassword() ?? undefined,
                };
            },
            onAuthFailure: async () => {
                new Notice(
                    "Authentication failed. Please try with different credentials"
                );
                const username = await new GeneralModal(this.plugin, {
                    placeholder: "Specify your username",
                }).openAndGetResult();
                if (username) {
                    const password = await new GeneralModal(this.plugin, {
                        placeholder:
                            "Specify your password/personal access token",
                    }).openAndGetResult();
                    if (password) {
                        this.plugin.localStorage.setUsername(username);
                        this.plugin.localStorage.setPassword(password);
                        return {
                            username,
                            password,
                        };
                    }
                }
                return { cancel: true };
            },
            http: {
                async request({
                    url,
                    method,
                    headers,
                    body,
                }: GitHttpRequest): Promise<GitHttpResponse> {
                    // We can't stream yet, so collect body and set it to the ArrayBuffer
                    // because that's what requestUrl expects
                    let collectedBody: ArrayBuffer | undefined;
                    if (body) {
                        collectedBody = (await collect(body)).buffer;
                    }

                    const res = await requestUrl({
                        url,
                        method,
                        headers,
                        body: collectedBody,
                        throw: false,
                    });
                    return {
                        url,
                        method,
                        headers: res.headers,
                        body: [new Uint8Array(res.arrayBuffer)],
                        statusCode: res.status,
                        statusMessage: res.status.toString(),
                    };
                },
            },
        };
    }

    async wrapFS<T>(call: Promise<T>): Promise<T> {
        try {
            const res = await call;
            await this.fs.saveAndClear();
            return res;
        } catch (error) {
            await this.fs.saveAndClear();
            throw error;
        }
    }

    async status(opts?: { path?: string }): Promise<Status> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.status });
            const statusOpts = { ...this.getRepo() } as Parameters<
                typeof git.statusMatrix
            >[0];
            if (opts?.path != undefined) {
                statusOpts.filepaths = [`${opts.path}/`];
            }
            const status = (
                await this.wrapFS(git.statusMatrix(statusOpts))
            ).map((row) => this.getFileStatusResult(row));

            const changed: FileStatusResult[] = [];
            const staged: FileStatusResult[] = [];
            const all: FileStatusResult[] = [];
            for (const file of status) {
                if (file.workingDir !== " ") {
                    changed.push(file);
                }
                if (file.index !== " " && file.index !== "U") {
                    staged.push(file);
                }
                if (file.index != " " || file.workingDir != " ") {
                    all.push(file);
                }
            }
            const conflicted: string[] = [];
            window.clearTimeout(timeout);
            notice?.hide();
            return { all, changed, staged, conflicted };
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            this.plugin.displayError(error);
            throw error;
        }
    }

    async commitAll({
        message,
        status,
        unstagedFiles,
    }: {
        message: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
    }): Promise<number | undefined> {
        try {
            await this.checkAuthorInfo();

            await this.stageAll({ status, unstagedFiles });
            return this.commit({ message });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async commit({
        message,
    }: {
        message: string;
        amend?: boolean;
    }): Promise<undefined> {
        try {
            await this.checkAuthorInfo();
            this.plugin.setPluginState({ gitAction: CurrentGitAction.commit });
            const formatMessage = await this.formatCommitMessage(message);
            const hadConflict = this.plugin.localStorage.getConflict();
            let parent: string[] | undefined = undefined;

            if (hadConflict) {
                const branchInfo = await this.branchInfo();
                parent = [branchInfo.current!, branchInfo.tracking!];
            }

            await this.wrapFS(
                git.commit({
                    ...this.getRepo(),
                    message: formatMessage,
                    parent: parent,
                })
            );
            this.plugin.localStorage.setConflict(false);
            return;
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
        let vaultPath: string;
        if (relativeToVault) {
            vaultPath = filepath;
        } else {
            vaultPath = this.getRelativeVaultPath(filepath);
        }
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.add });
            if (await this.app.vault.adapter.exists(vaultPath)) {
                await this.wrapFS(
                    git.add({ ...this.getRepo(), filepath: gitPath })
                );
            } else {
                await this.wrapFS(
                    git.remove({ ...this.getRepo(), filepath: gitPath })
                );
            }
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async stageAll({
        dir,
        status,
        unstagedFiles,
    }: {
        dir?: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
    }): Promise<void> {
        try {
            if (status) {
                await Promise.all(
                    status.changed.map((file) =>
                        file.workingDir !== "D"
                            ? this.wrapFS(
                                  git.add({
                                      ...this.getRepo(),
                                      filepath: file.path,
                                  })
                              )
                            : git.remove({
                                  ...this.getRepo(),
                                  filepath: file.path,
                              })
                    )
                );
            } else {
                const filesToStage =
                    unstagedFiles ?? (await this.getUnstagedFiles(dir ?? "."));
                await Promise.all(
                    filesToStage.map(({ path, type }) =>
                        type == "D"
                            ? git.remove({ ...this.getRepo(), filepath: path })
                            : this.wrapFS(
                                  git.add({ ...this.getRepo(), filepath: path })
                              )
                    )
                );
            }
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.add });
            filepath = this.getRelativeRepoPath(filepath, relativeToVault);
            await this.wrapFS(
                git.resetIndex({ ...this.getRepo(), filepath: filepath })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async unstageAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        try {
            let staged: string[];
            if (status) {
                staged = status.staged.map((file) => file.path);
            } else {
                const res = await this.getStagedFiles(dir ?? ".");
                staged = res.map(({ path }) => path);
            }
            await this.wrapFS(
                Promise.all(
                    staged.map((file) =>
                        git.resetIndex({ ...this.getRepo(), filepath: file })
                    )
                )
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async discard(filepath: string): Promise<void> {
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.add });
            await this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    filepaths: [filepath],
                    force: true,
                })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async discardAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let files: string[] = [];
        if (status) {
            if (dir != undefined) {
                files = status.changed
                    .filter(
                        (file) =>
                            file.workingDir != "U" && file.path.startsWith(dir)
                    )
                    .map((file) => file.path);
            } else {
                files = status.changed
                    .filter((file) => file.workingDir != "U")
                    .map((file) => file.path);
            }
        } else {
            files = (await this.getUnstagedFiles(dir))
                .filter((file) => file.type != "A")
                .map(({ path }) => path);
        }

        try {
            await this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    filepaths: files,
                    force: true,
                })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getUntrackedPaths(opts: {
        path?: string;
        status?: Status;
    }): Promise<string[]> {
        const untrackedPaths: string[] = [];
        if (opts.status) {
            for (const file of opts.status.changed) {
                if (
                    file.index == "U" &&
                    file.workingDir === "U" &&
                    file.path.startsWith(
                        opts.path != undefined ? `${opts.path}/` : ""
                    )
                ) {
                    untrackedPaths.push(file.path);
                }
            }
        } else {
            const status = await this.status({ path: opts?.path });
            for (const file of status.changed) {
                if (file.index === "U" && file.workingDir === "U") {
                    untrackedPaths.push(file.path);
                }
            }
        }
        return untrackedPaths;
    }

    getProgressText(action: string, event: GitProgressEvent): string {
        let out = `${action} progress:`;
        if (event.phase) {
            out = `${out} ${event.phase}:`;
        }
        if (event.loaded) {
            out = `${out} ${event.loaded}`;
            if (event.total) {
                out = `${out} of ${event.total}`;
            }
        }
        return out;
    }

    resolveRef(ref: string): Promise<string> {
        return this.wrapFS(git.resolveRef({ ...this.getRepo(), ref }));
    }

    async pull(): Promise<FileStatusResult[]> {
        const progressNotice = this.showNotice("Initializing pull");
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.pull });

            const localCommit = await this.resolveRef("HEAD");
            await this.fetch();
            const branchInfo = await this.branchInfo();

            await this.checkAuthorInfo();

            const mergeRes = await this.wrapFS(
                git.merge({
                    ...this.getRepo(),
                    ours: branchInfo.current,
                    theirs: branchInfo.tracking!,
                    abortOnConflict: false,
                })
            );
            if (!mergeRes.alreadyMerged) {
                await this.wrapFS(
                    git.checkout({
                        ...this.getRepo(),
                        ref: branchInfo.current,
                        onProgress: (progress) => {
                            if (progressNotice !== undefined) {
                                progressNotice.noticeEl.innerText =
                                    this.getProgressText("Checkout", progress);
                            }
                        },
                        remote: branchInfo.remote,
                    })
                );
            }
            progressNotice?.hide();

            const upstreamCommit = await this.resolveRef("HEAD");
            const changedFiles = await this.getFileChangesCount(
                localCommit,
                upstreamCommit
            );

            this.showNotice("Finished pull", false);

            return changedFiles.map<FileStatusResult>((file) => ({
                path: file.path,
                workingDir: "P",
                index: "P",
                vaultPath: this.getRelativeVaultPath(file.path),
            }));
        } catch (error) {
            progressNotice?.hide();
            if (error instanceof Errors.MergeConflictError) {
                await this.plugin.handleConflict(
                    error.data.filepaths.map((file) =>
                        this.getRelativeVaultPath(file)
                    )
                );
            }

            this.plugin.displayError(error);
            throw error;
        }
    }

    async push(): Promise<number> {
        if (!(await this.canPush())) {
            return 0;
        }
        const progressNotice = this.showNotice("Initializing push");
        try {
            this.plugin.setPluginState({ gitAction: CurrentGitAction.status });
            const status = await this.branchInfo();
            const trackingBranch = status.tracking;
            const currentBranch = status.current;
            const numChangedFiles = (
                await this.getFileChangesCount(currentBranch!, trackingBranch!)
            ).length;

            this.plugin.setPluginState({ gitAction: CurrentGitAction.push });

            await this.wrapFS(
                git.push({
                    ...this.getRepo(),
                    onProgress: (progress) => {
                        if (progressNotice !== undefined) {
                            progressNotice.noticeEl.innerText =
                                this.getProgressText("Pushing", progress);
                        }
                    },
                })
            );
            progressNotice?.hide();
            return numChangedFiles;
        } catch (error) {
            progressNotice?.hide();
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getUnpushedCommits(): Promise<number> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        if (trackingBranch == null || currentBranch == null) {
            return 0;
        }

        const localCommit = await this.resolveRef(currentBranch);
        const upstreamCommit = await this.resolveRef(trackingBranch);

        const changedFiles = await this.getFileChangesCount(
            localCommit,
            upstreamCommit
        );

        return changedFiles.length;
    }

    async canPush(): Promise<boolean> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        const current = await this.resolveRef(currentBranch!);
        const tracking = await this.resolveRef(trackingBranch!);

        return current != tracking;
    }

    async checkRequirements(): Promise<"valid" | "missing-repo"> {
        const headExists = await this.plugin.app.vault.adapter.exists(
            `${this.getRepo().dir}/.git/HEAD`
        );

        return headExists ? "valid" : "missing-repo";
    }

    async branchInfo(): Promise<BranchInfo & { remote: string }> {
        try {
            const current = (await git.currentBranch(this.getRepo())) || "";

            const branches = await git.listBranches(this.getRepo());

            const remote =
                (await this.getConfig(`branch.${current}.remote`)) ?? "origin";

            const trackingBranch = (
                await this.getConfig(`branch.${current}.merge`)
            )?.split("refs/heads")[1];

            const tracking = trackingBranch
                ? remote + trackingBranch
                : undefined;

            return {
                current: current,
                tracking: tracking,
                branches: branches,
                remote: remote,
            };
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getCurrentRemote(): Promise<string> {
        const current = (await git.currentBranch(this.getRepo())) || "";

        const remote =
            (await this.getConfig(`branch.${current}.remote`)) ?? "origin";
        return remote;
    }

    async checkout(branch: string, remote?: string): Promise<void> {
        try {
            return this.wrapFS(
                git.checkout({
                    ...this.getRepo(),
                    ref: branch,
                    force: !!remote,
                    remote,
                })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async createBranch(branch: string): Promise<void> {
        try {
            await this.wrapFS(
                git.branch({ ...this.getRepo(), ref: branch, checkout: true })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async deleteBranch(branch: string): Promise<void> {
        try {
            await this.wrapFS(
                git.deleteBranch({ ...this.getRepo(), ref: branch })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    branchIsMerged(_: string): Promise<boolean> {
        return Promise.resolve(true);
    }

    async init(): Promise<void> {
        try {
            await this.wrapFS(git.init(this.getRepo()));
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async clone(url: string, dir: string, depth?: number): Promise<void> {
        const progressNotice = this.showNotice("Initializing clone");
        try {
            await this.wrapFS(
                git.clone({
                    ...this.getRepo(),
                    dir: dir,
                    url: url,
                    depth: depth,
                    onProgress: (progress) => {
                        if (progressNotice !== undefined) {
                            progressNotice.noticeEl.innerText =
                                this.getProgressText("Cloning", progress);
                        }
                    },
                })
            );
            progressNotice?.hide();
        } catch (error) {
            progressNotice?.hide();
            this.plugin.displayError(error);
            throw error;
        }
    }

    async setConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<void> {
        try {
            return this.wrapFS(
                git.setConfig({
                    ...this.getRepo(),
                    path: path,
                    value: value,
                })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getConfig(path: string): Promise<string> {
        try {
            return this.wrapFS(
                git.getConfig({
                    ...this.getRepo(),
                    path: path,
                }) as Promise<string>
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async fetch(remote?: string): Promise<void> {
        const progressNotice = this.showNotice("Initializing fetch");

        try {
            const args = {
                ...this.getRepo(),
                onProgress: (progress: GitProgressEvent) => {
                    if (progressNotice !== undefined) {
                        progressNotice.noticeEl.innerText =
                            this.getProgressText("Fetching", progress);
                    }
                },
                remote: remote ?? (await this.getCurrentRemote()),
            };

            await this.wrapFS(git.fetch(args));
            progressNotice?.hide();
        } catch (error) {
            this.plugin.displayError(error);
            progressNotice?.hide();
            throw error;
        }
    }

    async setRemote(name: string, url: string): Promise<void> {
        try {
            await this.wrapFS(
                git.addRemote({
                    ...this.getRepo(),
                    remote: name,
                    url: url,
                    force: true,
                })
            );
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getRemoteBranches(remote: string): Promise<string[]> {
        let remoteBranches = [];
        remoteBranches.push(
            ...(await this.wrapFS(
                git.listBranches({ ...this.getRepo(), remote: remote })
            ))
        );

        remoteBranches.remove("HEAD");

        //Align with simple-git
        remoteBranches = remoteBranches.map((e) => `${remote}/${e}`);
        return remoteBranches;
    }

    async getRemotes(): Promise<string[]> {
        return (await this.wrapFS(git.listRemotes({ ...this.getRepo() }))).map(
            (remoteUrl) => remoteUrl.remote
        );
    }

    async removeRemote(remoteName: string): Promise<void> {
        await this.wrapFS(
            git.deleteRemote({ ...this.getRepo(), remote: remoteName })
        );
    }

    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return (
            await this.wrapFS(git.listRemotes({ ...this.getRepo() }))
        ).filter((item) => item.remote == remote)[0]?.url;
    }

    async log(
        _?: string,
        __ = true,
        limit?: number,
        ref?: string
    ): Promise<LogEntry[]> {
        const logs = await this.wrapFS(
            git.log({ ...this.getRepo(), depth: limit, ref: ref })
        );

        return Promise.all(
            logs.map(async (log) => {
                const completeMessage = log.commit.message.split("\n\n");

                return {
                    message: completeMessage[0],
                    author: {
                        name: log.commit.author.name,
                        email: log.commit.author.email,
                    },
                    body: completeMessage.slice(1).join("\n\n"),
                    date: new Date(
                        log.commit.committer.timestamp
                    ).toDateString(),
                    diff: {
                        changed: 0,
                        files: (
                            await this.getFileChangesCount(
                                log.commit.parent.first()!,
                                log.oid
                            )
                        ).map<DiffFile>((item) => {
                            return {
                                path: item.path,
                                status: item.type,
                                vaultPath: this.getRelativeVaultPath(item.path),
                                hash: log.oid,
                            };
                        }),
                    },
                    hash: log.oid,
                    refs: [],
                };
            })
        );
    }

    updateBasePath(basePath: string): Promise<void> {
        this.getRepo().dir = basePath;
        return Promise.resolve();
    }

    async updateUpstreamBranch(remoteBranch: string): Promise<void> {
        const [remote, branch] = splitRemoteBranch(remoteBranch);
        const branchInfo = await this.branchInfo();

        await this.wrapFS(
            git.push({
                ...this.getRepo(),
                remote: remote,
                remoteRef: branch,
            })
        );

        await this.setConfig(
            `branch.${branchInfo.current}.merge`,
            `refs/heads/${branch}`
        );
    }

    updateGitPath(_: string): Promise<void> {
        // isomorphic-git library has its own git client
        return Promise.resolve();
    }

    async getFileChangesCount(
        commitHash1: string,
        commitHash2: string
    ): Promise<WalkDifference[]> {
        return this.walkDifference({
            walkers: [
                git.TREE({ ref: commitHash1 }),
                git.TREE({ ref: commitHash2 }),
            ],
        });
    }

    async walkDifference({
        walkers,
        dir: base,
    }: {
        walkers: Walker[];
        dir?: string;
    }): Promise<WalkDifference[]> {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const res = await this.wrapFS(
            git.walk({
                ...this.getRepo(),
                trees: walkers,
                map: async function (filepath, [A, B]) {
                    if (!worthWalking(filepath, base)) {
                        return null;
                    }

                    if (
                        (await A?.type()) === "tree" ||
                        (await B?.type()) === "tree"
                    ) {
                        return;
                    }

                    // generate ids
                    const Aoid = await A?.oid();
                    const Boid = await B?.oid();

                    // determine modification type
                    let type = "equal";
                    if (Aoid !== Boid) {
                        type = "M";
                    }
                    if (Aoid === undefined) {
                        type = "A";
                    }
                    if (Boid === undefined) {
                        type = "D";
                    }

                    if (Aoid === undefined && Boid === undefined) {
                        console.log("Something weird happened:");
                        console.log(A);
                        console.log(B);
                    }
                    if (type === "equal") {
                        return;
                    }

                    return {
                        path: filepath,
                        type: type,
                    };
                },
            })
        );
        return res as WalkDifference[];
    }

    async getStagedFiles(
        dir = "."
    ): Promise<{ vaultPath: string; path: string }[]> {
        const res = await this.walkDifference({
            walkers: [git.TREE({ ref: "HEAD" }), git.STAGE()],
            dir,
        });
        return res.map((file) => {
            return {
                vaultPath: this.getRelativeVaultPath(file.path),
                path: file.path,
            };
        });
    }

    async getUnstagedFiles(base = "."): Promise<UnstagedFile[]> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const repo = this.getRepo();
            const res = await this.wrapFS<Promise<UnstagedFile[]>>(
                //Modified from `git.statusMatrix`
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                git.walk({
                    ...repo,
                    trees: [git.WORKDIR(), git.STAGE()],
                    map: async function (
                        filepath,
                        [workdir, stage]
                    ): Promise<UnstagedFile | null | undefined> {
                        // Ignore ignored files, but only if they are not already tracked.
                        if (!stage && workdir) {
                            const isIgnored = await git.isIgnored({
                                ...repo,
                                filepath,
                            });
                            if (isIgnored) {
                                return null;
                            }
                        }
                        // match against base path
                        if (!worthWalking(filepath, base)) {
                            return null;
                        }
                        // Late filter against file names
                        // if (filter) {
                        //     if (!filter(filepath)) return;
                        // }

                        const [workdirType, stageType] = await Promise.all([
                            workdir && workdir.type(),
                            stage && stage.type(),
                        ]);

                        const isBlob = [workdirType, stageType].includes(
                            "blob"
                        );

                        // For now, bail on directories unless the file is also a blob in another tree
                        if (
                            (workdirType === "tree" ||
                                workdirType === "special") &&
                            !isBlob
                        )
                            return;

                        if (stageType === "commit") return null;
                        if (
                            (stageType === "tree" || stageType === "special") &&
                            !isBlob
                        )
                            return;

                        // Figure out the oids for files, using the staged oid for the working dir oid if the stats match.
                        const stageOid =
                            stageType === "blob"
                                ? await stage!.oid()
                                : undefined;
                        let workdirOid;
                        if (workdirType === "blob" && stageType !== "blob") {
                            // We don't actually NEED the sha. Any sha will do
                            workdirOid = "42";
                        } else if (workdirType === "blob") {
                            workdirOid = await workdir!.oid();
                        }
                        if (!workdirOid) {
                            return {
                                path: filepath,
                                type: "D",
                            };
                        }
                        if (!stageOid) {
                            return {
                                path: filepath,
                                type: "A",
                            };
                        }

                        if (workdirOid !== stageOid) {
                            return {
                                path: filepath,
                                type: "M",
                            };
                        }
                        return null;
                        // const entry = [undefined, headOid, workdirOid, stageOid];
                        // const result = entry.map(value => entry.indexOf(value));
                        // result.shift(); // remove leading undefined entry
                        // return [filepath, ...result];
                    },
                })
            );
            window.clearTimeout(timeout);
            notice?.hide();
            return res;
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            this.plugin.displayError(error);
            throw error;
        }
    }

    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        const vaultPath = this.getRelativeVaultPath(filePath);

        const map: WalkerMap = async (file, [A]) => {
            if (filePath == file) {
                const oid = await A!.oid();
                const contents = await git.readBlob({
                    ...this.getRepo(),
                    oid: oid,
                });
                return contents.blob;
            }
        };
        if (hash) {
            const commitContent = await readBlob({
                ...this.getRepo(),
                filepath: filePath,
                oid: hash,
            })
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });
            const commit = await git.readCommit({
                ...this.getRepo(),
                oid: hash,
            });

            const previousContent = await readBlob({
                ...this.getRepo(),
                filepath: filePath,
                oid: commit.commit.parent.first()!,
            })
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });

            const diff = createPatch(
                vaultPath,
                previousContent ?? "",
                commitContent ?? ""
            );
            return diff;
        }

        const stagedBlob = (
            (await git.walk({
                ...this.getRepo(),
                trees: [git.STAGE()],
                map,
            })) as Uint8Array[]
        ).first();
        const stagedContent = new TextDecoder().decode(stagedBlob);

        if (stagedChanges) {
            const headContent = await this.resolveRef("HEAD")
                .then((oid) =>
                    readBlob({
                        ...this.getRepo(),
                        filepath: filePath,
                        oid: oid,
                    })
                )
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });

            const diff = createPatch(
                vaultPath,
                headContent ?? "",
                stagedContent
            );
            return diff;
        } else {
            let workdirContent: string;
            if (await this.app.vault.adapter.exists(vaultPath)) {
                workdirContent = await this.app.vault.adapter.read(vaultPath);
            } else {
                workdirContent = "";
            }

            const diff = createPatch(vaultPath, stagedContent, workdirContent);
            return diff;
        }
    }

    async getLastCommitTime(): Promise<Date | undefined> {
        const repo = this.getRepo();
        const oid = await this.resolveRef("HEAD");
        const commit = await git.readCommit({ ...repo, oid: oid });
        const date = commit.commit.committer.timestamp;
        return new Date(date * 1000);
    }

    private getFileStatusResult(
        row: [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3]
    ): FileStatusResult {
        // eslint-disable-next-line  @typescript-eslint/no-explicit-any
        const status = (this.status_mapping as any)[
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            `${row[this.HEAD]}${row[this.WORKDIR]}${row[this.STAGE]}`
        ] as string;
        // status will always be two characters
        return {
            index: status[0] == "?" ? "U" : status[0],
            workingDir: status[1] == "?" ? "U" : status[1],
            path: row[this.FILE],
            vaultPath: this.getRelativeVaultPath(row[this.FILE]),
        };
    }

    private async checkAuthorInfo(): Promise<void> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
    }

    private showNotice(message: string, infinity = true): Notice | undefined {
        if (!this.plugin.settings.disablePopups) {
            return new Notice(
                message,
                infinity ? this.noticeLength : undefined
            );
        }
    }
}

// All because we can't use (for await)...

// Convert a value to an Async Iterator
// This will be easier with async generator functions.

/*eslint-disable */
function fromValue(value: any) {
    let queue = [value];
    return {
        next() {
            return Promise.resolve({
                done: queue.length === 0,
                value: queue.pop(),
            });
        },
        return() {
            queue = [];
            return {};
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };
}

function getIterator(iterable: any) {
    if (iterable[Symbol.asyncIterator]) {
        return iterable[Symbol.asyncIterator]();
    }
    if (iterable[Symbol.iterator]) {
        return iterable[Symbol.iterator]();
    }
    if (iterable.next) {
        return iterable;
    }
    return fromValue(iterable);
}

async function forAwait(iterable: any, cb: any) {
    const iter = getIterator(iterable);
    while (true) {
        const { value, done } = await iter.next();
        if (value) await cb(value);
        if (done) break;
    }
    if (iter.return) iter.return();
}

async function collect(iterable: any): Promise<Uint8Array> {
    let size = 0;
    const buffers: Uint8Array[] = [];
    // This will be easier once `for await ... of` loops are available.
    await forAwait(iterable, (value: any) => {
        buffers.push(value);
        size += value.byteLength;
    });
    const result = new Uint8Array(size);
    let nextIndex = 0;
    for (const buffer of buffers) {
        result.set(buffer, nextIndex);
        nextIndex += buffer.byteLength;
    }
    return result;
}
