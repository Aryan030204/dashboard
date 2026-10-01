const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const customRoleController = require('../controllers/customRole.controller');

const jwksController = require('../controllers/jwks.controller');

router.get('/.well-known/jwks.json', jwksController.getJwks);
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-all-self', authController.logoutAllSelf);
router.get('/me', authController.me);
router.get('/client-settings', authController.getClientSettings);
router.post('/admin/client-settings', authController.adminUpdateClientSettings);
router.get('/google/start', authController.googleStart);
router.get('/google/callback', authController.googleCallback);
router.post('/admin/users', authController.adminUpsertUser);
router.delete('/admin/users/:email', authController.adminDeleteUser);
router.get('/admin/users', authController.adminListUsers);
router.post('/admin/domain-rules', authController.adminUpsertDomainRule);
router.get('/admin/domain-rules', authController.adminListDomainRules);
router.delete('/admin/domain-rules/:domain', authController.adminDeleteDomainRule);

router.get('/admin/custom-roles', customRoleController.listCustomRoles);
router.get('/admin/custom-roles/:id', customRoleController.getCustomRole);
router.post('/admin/custom-roles', customRoleController.createCustomRole);
router.patch('/admin/custom-roles/:id', customRoleController.updateCustomRole);
router.delete('/admin/custom-roles/:id', customRoleController.deleteCustomRole);

module.exports = router;
