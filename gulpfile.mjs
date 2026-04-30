/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './build/gulpfile.ts';
import gulp from 'gulp';

// Rebranding aliases: darkmatter-* -> vscode-*
const platforms = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-armhf', 'linux-arm64'];
platforms.forEach(platform => {
	['', '-min', '-ci', '-min-ci'].forEach(suffix => {
		const vscodeTask = `vscode-${platform}${suffix}`;
		const darkmatterTask = `darkmatter-${platform}${suffix}`;
		gulp.task(darkmatterTask, (cb) => {
			const taskFn = gulp.task(vscodeTask);
			if (taskFn) {
				return taskFn(cb);
			}
			cb(new Error(`Task ${vscodeTask} not found`));
		});
	});
});

