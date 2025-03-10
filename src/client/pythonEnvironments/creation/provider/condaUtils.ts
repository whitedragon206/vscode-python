// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, QuickPickItem, Uri } from 'vscode';
import { Common } from '../../../browser/localize';
import { CreateEnv } from '../../../common/utils/localize';
import { executeCommand } from '../../../common/vscodeApis/commandApis';
import { showErrorMessage, showQuickPick } from '../../../common/vscodeApis/windowApis';
import { Conda } from '../../common/environmentManagers/conda';

export async function getConda(): Promise<string | undefined> {
    const conda = await Conda.getConda();

    if (!conda) {
        const response = await showErrorMessage(CreateEnv.Conda.condaMissing, Common.learnMore);
        if (response === Common.learnMore) {
            await executeCommand('vscode.open', Uri.parse('https://docs.anaconda.com/anaconda/install/'));
        }
        return undefined;
    }
    return conda.command;
}

export async function pickPythonVersion(token?: CancellationToken): Promise<string | undefined> {
    const items: QuickPickItem[] = ['3.10', '3.9', '3.8', '3.7'].map((v) => ({
        label: `Python`,
        description: v,
    }));
    const version = await showQuickPick(
        items,
        {
            placeHolder: CreateEnv.Conda.selectPythonQuickPickPlaceholder,
        },
        token,
    );
    return version?.description;
}
