//todo: for live
// exports.dbs = {
// 	mysql_bpr: {
//         read: 'redoq-dev-db-cluster.cluster-cs0kxsrqdtm7.ap-south-1.rds.amazonaws.com',
//         write: 'redoq-dev-db-cluster.cluster-cs0kxsrqdtm7.ap-south-1.rds.amazonaws.com',
//         database: 'project_investapas',
//     },
// };

//todo: for local
exports.dbs = {
	mysql_bpr: {
        read: 'localhost',
        write: 'localhost',
        database: 'investapas',
    },
};

//todo: for live
// exports.dbs_login = {
//     apiservice: {
//         user: 'savan.18seq',
//         password: '1qaz!QAZ@WSX'
//     }
// };

//todo: for local
exports.dbs_login = {
    apiservice: {
        user: 'root',
        password: ''
    }
};

exports.mongodbs = {
    
    // mysql_dine_server_common: {
    //     host: 'redoq.mongodb.net',
    //     database: 'redoq_db',
    //     user: 'root',
    //     password: 'a1b2c3',
    // }
};
