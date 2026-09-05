const multer = require('multer')
const path = require('path');
const fs = require('fs');
const { validationErrorResponse, ErrorResponse } = require('../vars/apiResponse');
const utility = require('../helpers/utility');

const FileManager = exports;

exports.getFileName = (file) => {
    return file.originalname.split('.')[0].replace(/[^A-Z0-9]/ig, "_") + '_' + Date.now() + '_' + Math.floor(Math.random() * 999) + 99 + path.extname(file.originalname)
}

exports.resolvePath = (filepath) => {

    let utilPath = (__dirname[0] == '/' ? __dirname.slice(1) : __dirname).split("/");

    utilPath.pop();

    let PathJoin = utilPath.join("/") + "/Assets" + filepath;

    let pathToCreateFolder = PathJoin.split("/");

    let folderToCreate = __dirname[0] == '/' ? "/" + utilPath.join("/") : utilPath.join("/");

    for (let i = utilPath?.length; i <= pathToCreateFolder?.length - 1; i++) {
        folderToCreate = folderToCreate.concat("/" + pathToCreateFolder[i])
        if (!fs.existsSync(folderToCreate)) {
            fs.mkdirSync(folderToCreate);
        }
    }

    return path.join(__dirname, "../Assets/" + filepath + "/")
}

exports.userUploadImage = (folderName) => {

    const storage = multer.memoryStorage();
    const upload = multer({ storage }).any();
    let response = {};
    response['status'] = 'error';
    response['msg'] = '';

    return (req, res, next) => {
        upload(req, res, function (err) {
            if (err) return ErrorResponse(res, 'Upload Error.');

            try {

                if (!req.files || req.files.length === 0) {
                    return next();
                }

                for (const file of req.files) {
                    const { originalname, mimetype, size } = file;

                    if (mimetype === 'video/mp4' && size > 2 * 1024 * 1024) {
                        response['msg'] = `Video file ${originalname} exceeds 2 MB size limit.`;
                        return utility.apiResponse(req, res, response);
                        // return validationErrorResponse(res, `Video file "${originalname}" exceeds 2 MB size limit.`);
                        // return res.status(400).json({ message: `Video file "${originalname}" exceeds 2 MB size limit.` });
                    }

                    if (mimetype !== 'image/jpeg' && mimetype !== 'audio/mpeg' && mimetype !== 'video/mp4') {
                        response['msg'] = `Unsupported file type: ${mimetype}`;
                        return utility.apiResponse(req, res, response);
                    }
                }

                for (const file of req.files) {

                    const { mimetype, buffer, fieldname } = file;

                    let folderPath = '';
                    if (mimetype === 'image/jpeg') {
                        folderPath = FileManager.resolvePath(folderName + 'image');
                    } else if (mimetype === 'audio/mpeg') {
                        folderPath = FileManager.resolvePath(folderName + 'audio');
                    } else if (mimetype === 'video/mp4') {
                        folderPath = FileManager.resolvePath(folderName + 'video');
                    }

                    let fileName = FileManager.getFileName(file);
                    const fullPath = path.join(folderPath, fileName);

                    fs.writeFileSync(fullPath, buffer);

                    if (!req.body[fieldname]) req.body[fieldname] = [];
                    req.body[fieldname].push(fileName);
                }

                next();
            } catch (err) {
                ErrorResponse(res, 'Internal server error during file processing.');
                // res.status(500).json({ message: 'Internal server error during file processing.' });
            }
        });
    };

    // var storage = multer.diskStorage({
    //     destination: function (req, file, callBack) {
    //         if (file.mimetype === 'image/jpeg') {
    //             callBack(null, FileManager.resolvePath(folderName + 'image'));
    //         } else if (file.mimetype === 'audio/mpeg') {
    //             callBack(null, FileManager.resolvePath(folderName + 'audio'))
    //         } else if (file.mimetype === 'video/mp4') {
    //             callBack(null, FileManager.resolvePath(folderName + 'video'))
    //         }
    //     }.bind(this),
    //     filename: function (req, file, callBack) {
    //         let fileName = FileManager.getFileName(file);
    //         if (!req.body[file.fieldname]) {
    //             req.body[file.fieldname] = []
    //             req.body[file.fieldname].push(fileName)
    //         } else
    //             req.body[file.fieldname].push(fileName)
    //         callBack(null, fileName)
    //     }.bind(this),
    // })

    // return multer({ storage })
}

exports.userUploadProfilePicture = (folderName) => {
    var storage = multer.diskStorage({
        destination: function (req, file, callBack) {
            callBack(null, FileManager.resolvePath(folderName));
        }.bind(this),
        filename: function (req, file, callBack) {
            let fileName = FileManager.getFileName(file);
            if (!req.body[file.fieldname]) {
                req.body[file.fieldname] = []
                req.body[file.fieldname].push(fileName)
            } else
                req.body[file.fieldname].push(fileName)
            callBack(null, fileName)
        }.bind(this),
    })

    return multer({ storage })
}

// Delete file from folder
exports.unlinkRemoveFile = async (folderName, fileName) => {
    let localPath = this.resolvePath(folderName);
    fs.unlink(localPath + fileName, function (err) {
        if (err) {
            return { data: err, status: false };
        } else {
            return { data: "err", status: true };
        }
    })
}