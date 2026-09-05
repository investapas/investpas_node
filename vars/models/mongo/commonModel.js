exports.commonModel = {
  apilog: {
    model: {
      apilog_Product: {
        type: String,
      },
      apilog_Request_Method: {
        type: String,
      },
      apilog_Ip: {
        type: String,
      },
      apilog_Request_Origin: {
        type: String,
      },
      apilog_Request_Url: {
        type: String,
      },
      apilog_Full_Url: {
        type: String,
      },
      apilog_Request_Headers: {
        type: Object,
      },
      apilog_Request_Body: {
        type: Object,
      },
      apilog_Request_Response: {
        type: Object,
      },
    },
    options: {
      timestamps: {
        createdAt: "created_at",
        updatedAt: "updated_at",
        deletedAt: "deleted_at",
      },
    },
  }
};
