const gulp = require('gulp');
const del = require('del');
const pump = require('pump');
const copydeps = require('gulp-npm-copy-deps');
const archiver = require('archiver');
const fs = require('fs');

gulp.task('config', function () {
    return pump([
        gulp.src('./config.json'),
        gulp.dest('./release')
    ]);
});

gulp.task('main', function () {
    return pump([
        gulp.src('./index.js'),
        gulp.dest('./release')
    ]);
});

gulp.task('dependencies', function () {
    return copydeps('./', './release');
});

gulp.task('package', function () {
    const release_zip = archiver('zip');
    release_zip.directory('./release', '');

    const release_zip_stream = fs.createWriteStream('./release/release.zip');
    release_zip.pipe(release_zip_stream);

    release_zip.finalize();
    return release_zip;
});

gulp.task('clean', function () {
    return del(['./release/**/*']);
});

gulp.task('release', gulp.series('clean', gulp.parallel('main', 'config', 'dependencies'), 'package'));
